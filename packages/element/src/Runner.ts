import { ConcreteLaunchOptions, PuppeteerClient, NullPuppeteerClient } from './driver/Puppeteer'
import { RuntimeEnvironment } from './runtime-environment/types'
import { Logger } from 'winston'
import Test from './runtime/Test'
import { TestObserver } from './runtime/test-observers/Observer'
import { TestSettings, ConcreteTestSettings } from './runtime/Settings'
import { IReporter } from './Reporter'
import { AsyncFactory } from './utils/Factory'
import { TestScriptError, ITestScript } from './TestScript'

export interface TestCommander {
	on(event: 'rerun-test', listener: () => void): this
}

export interface IRunner {
	run(testScriptFactory: AsyncFactory<ITestScript>): Promise<void>
	stop(): Promise<void>
}

function delay(t: number, v?: any) {
	return new Promise(function(resolve) {
		setTimeout(resolve.bind(null, v), t)
	})
}

class Looper {
	public iterations = 0
	private timeout: NodeJS.Timer
	private cancelled = false
	private loopCount: number

	constructor(settings: ConcreteTestSettings, running = true) {
		if (settings.duration > 0) {
			this.timeout = setTimeout(() => {
				this.cancelled = true
			}, settings.duration * 1e3)
		}

		this.loopCount = settings.loopCount
		this.cancelled = !running
	}

	stop() {
		this.cancelled = true
	}

	finish() {
		clearTimeout(this.timeout)
	}

	get continueLoop(): boolean {
		const hasInfiniteLoops = this.loopCount <= 0
		const hasLoopsLeft = this.iterations < this.loopCount

		return !this.cancelled && (hasLoopsLeft || hasInfiniteLoops)
	}

	async run(iterator: (iteration: number) => Promise<void>): Promise<number> {
		while (this.continueLoop) {
			await iterator(++this.iterations)
		}
		this.finish()
		return this.iterations
	}
}

export class Runner {
	private looper: Looper
	running = true
	public clientPromise: Promise<PuppeteerClient> | undefined

	constructor(
		private clientFactory: AsyncFactory<PuppeteerClient>,
		protected testCommander: TestCommander | undefined,
		private runEnv: RuntimeEnvironment,
		private reporter: IReporter,
		protected logger: Logger,
		private testSettingOverrides: TestSettings,
		private launchOptionOverrides: Partial<ConcreteLaunchOptions>,
		private testObserverFactory: (t: TestObserver) => TestObserver = x => x,
	) {}

	// interrupt() {
	// this.interrupts++
	// }

	// async shutdown(): Promise<void> {
	// this.interrupts++
	// this.logger.info('Shutting down...')
	// // if (this.test) {
	// // await this.test.shutdown()
	// // }

	// if (this.shouldShutdownBrowser) {
	// clearTimeout(this.timeout)
	// this.testContinue = false
	// this.logger.debug('Closing driver: Google Chrome...')
	// try {
	// await this.driver.close()
	// } catch (err) {
	// console.error(`Error while closing browser: ${err}`)
	// }
	// }
	// }

	async stop(): Promise<void> {
		this.running = false
		if (this.looper) this.looper.stop()
		if (this.clientPromise) (await this.clientPromise).close()
		return
	}

	get shouldShutdownBrowser(): boolean {
		return !!this.launchOptionOverrides.headless && !this.launchOptionOverrides.devtools
	}

	async run(testScriptFactory: AsyncFactory<ITestScript>): Promise<void> {
		const testScript = await testScriptFactory()

		this.clientPromise = this.launchClient(testScript)

		await this.runTestScript(testScript, this.clientPromise)
	}

	async launchClient(testScript: ITestScript): Promise<PuppeteerClient> {
		// evaluate the script so that we can get its settings
		// TODO refactor into EvaluatedTestScript
		const settings = new Test(
			new NullPuppeteerClient(),
			this.runEnv,
			this.reporter,
			this.testObserverFactory,
		).enqueueScript(testScript, this.testSettingOverrides)

		const options: Partial<ConcreteLaunchOptions> = this.launchOptionOverrides
		options.ignoreHTTPSErrors = settings.ignoreHTTPSErrors

		return this.clientFactory(options)
	}

	async runTestScript(
		testScript: ITestScript,
		clientPromise: Promise<PuppeteerClient>,
	): Promise<void> {
		if (!this.running) return

		console.log('running test script')
		const test = new Test(await clientPromise, this.runEnv, this.reporter, this.testObserverFactory)
		// this.test = test

		try {
			const settings = test.enqueueScript(testScript, this.testSettingOverrides)

			if (settings.name) {
				this.logger.info(`
*************************************************************
* Loaded test plan: ${settings.name}
* ${settings.description}
*************************************************************
				`)
			}

			if (settings.duration > 0) {
				this.logger.debug(`Test timeout set to ${settings.duration}s`)
			}
			this.logger.debug(`Test loop count set to ${settings.loopCount} iterations`)
			this.logger.debug(`Settings: ${JSON.stringify(settings, null, 2)}`)

			await test.beforeRun()

			console.log('looper')
			this.looper = new Looper(settings, this.running)
			await this.looper.run(async iteration => {
				this.logger.info(`Starting iteration ${iteration}`)

				let startTime = new Date()
				try {
					await test.run(iteration)
				} catch (err) {
					this.logger.error(
						`[Iteration: ${iteration}] Error in Runner Loop: ${err.name}: ${err.message}\n${
							err.stack
						}`,
					)
					throw err
				}
				let duration = new Date().valueOf() - startTime.valueOf()
				this.logger.info(`Iteration completed in ${duration}ms (walltime)`)
			})

			this.logger.info(`Test completed after ${this.looper.iterations} iterations`)
			return
		} catch (err) {
			if (err instanceof TestScriptError) {
				this.logger.error('\n' + err.toStringNodeFormat())
			} else {
				this.logger.error('internal flood-chrome error')
			}

			// if (process.env.NODE_ENV !== 'production') {
			this.logger.debug(err.stack)
			// }

			await test.cancel()
		}
	}
}

export class PersistentRunner extends Runner {
	public testScriptFactory: AsyncFactory<ITestScript> | undefined
	public clientPromise: Promise<PuppeteerClient> | undefined
	private stopped = false

	constructor(
		clientFactory: AsyncFactory<PuppeteerClient>,
		testCommander: TestCommander | undefined,
		runEnv: RuntimeEnvironment,
		reporter: IReporter,
		logger: Logger,
		testSettingOverrides: TestSettings,
		launchOptionOverrides: Partial<ConcreteLaunchOptions>,
		testObserverFactory: (t: TestObserver) => TestObserver = x => x,
	) {
		super(
			clientFactory,
			testCommander,
			runEnv,
			reporter,
			logger,
			testSettingOverrides,
			launchOptionOverrides,
			testObserverFactory,
		)

		if (this.testCommander !== undefined) {
			this.testCommander.on('rerun-test', () => this.rerunTest())
		}
	}

	rerunTest() {
		// destructure for type checking (narrowing past undefined)
		const { clientPromise, testScriptFactory } = this
		if (clientPromise === undefined) {
			return
		}
		if (testScriptFactory === undefined) {
			return
		}

		setImmediate(async () => {
			console.log('persistent runner got a command: rerun')

			try {
				await this.runTestScript(await testScriptFactory(), clientPromise)
			} catch (err) {
				this.logger.error('an error occurred in the script')
				this.logger.error(err)
			}
		})
	}

	async stop() {
		this.stopped = true
	}

	async waitUntilStopped(): Promise<void> {
		if (this.stopped) {
			return
		} else {
			await delay(1000)
			return this.waitUntilStopped()
		}
	}

	async run(testScriptFactory: AsyncFactory<ITestScript>): Promise<void> {
		this.testScriptFactory = testScriptFactory

		// TODO detect changes in testScript settings affecting the client
		this.clientPromise = this.launchClient(await testScriptFactory())

		this.rerunTest()
		await this.waitUntilStopped()
		// return new Promise<void>((resolve, reject) => {})
	}
}
