import Interceptor from '../network/Interceptor'
import { Browser } from './Browser'
// import { Browser as BrowserInterface } from './IBrowser'

import { IReporter } from '../Reporter'
import { NullReporter } from '../reporter/Null'
import { ObjectTrace } from '../utils/ObjectTrace'

import {
	TestObserver,
	NullTestObserver,
	LifecycleObserver,
	ErrorObserver,
	InnerObserver,
	TimingObserver,
	Context,
	NetworkRecordingTestObserver,
} from './test-observers'

import { AnyErrorData, EmptyErrorData, AssertionErrorData } from './errors/Types'
import { StructuredError } from '../utils/StructuredError'

import { Step, StepRecoveryObject, SummaryStep, StepResult } from './Step'
import { Looper } from '../Looper'

import { CancellationToken } from '../utils/CancellationToken'

import { PuppeteerClientLike } from '../driver/Puppeteer'
import { ScreenshotOptions } from 'puppeteer'
import { TestSettings, ConcreteTestSettings, DEFAULT_STEP_WAIT_SECONDS } from './Settings'
import { ITest } from './ITest'
import { EvaluatedScriptLike } from './EvaluatedScriptLike'
import { Hook, HookBase } from './StepLifeCycle'
import chalk from 'chalk'
// import { getNumberWithOrdinal } from '../utils/numerical'
import StepIterator from './StepIterator'
import { getNumberWithOrdinal } from '../utils/numerical'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const debug = require('debug')('element:runtime:test')

export default class Test implements ITest {
	public settings: ConcreteTestSettings
	public steps: Step[]
	public hook: Hook
	public recoverySteps: StepRecoveryObject

	public runningBrowser: Browser<Step> | null

	public requestInterceptor: Interceptor

	private testCancel: () => Promise<void> = async () => {
		return
	}

	public iteration = 0

	public failed: boolean

	public summaryStep: SummaryStep[] = []
	public subTitle: string

	get skipping(): boolean {
		return this.failed
	}

	constructor(
		public client: PuppeteerClientLike,
		public script: EvaluatedScriptLike,
		public reporter: IReporter = new NullReporter(),
		settingsOverride: TestSettings,
		public testObserverFactory: (t: TestObserver) => TestObserver = x => x,
	) {
		this.script = script

		try {
			const { settings, steps, recoverySteps, hook } = script
			this.settings = settings as ConcreteTestSettings
			this.steps = steps
			this.recoverySteps = recoverySteps
			this.hook = hook

			// Adds output for console in script
			script.bindTest(this)
		} catch (err) {
			// XXX parsing errors. Lift to StructuredError?
			throw this.script.maybeLiftError(err)
		}

		Object.assign(this.settings, settingsOverride)
		this.requestInterceptor = new Interceptor(this.settings.blockedDomains || [])
	}

	public async cancel() {
		this.failed = true
		await this.testCancel()
	}

	public async beforeRun(): Promise<void> {
		debug('beforeRun()')
		await this.script.beforeTestRun()
	}

	public summarizeStep(): SummaryStep[] {
		return this.summaryStep
	}
	public resetSummarizeStep(): void {
		this.summaryStep = []
	}

	/**
	 * Runs the group of steps
	 * @return {Promise<void|Error>}
	 */
	public async run(iteration?: number): Promise<void> | never {
		await this.runWithCancellation(
			iteration || 0,
			new CancellationToken(),
			new Looper(this.settings),
		)
	}

	public async runWithCancellation(
		iteration: number,
		cancelToken: CancellationToken,
		looper: Looper,
	): Promise<void> {
		console.assert(this.client, `client is not configured in Test`)

		const ctx = new Context()

		const testObserver = new ErrorObserver(
			new LifecycleObserver(
				this.testObserverFactory(
					new TimingObserver(
						ctx,
						new NetworkRecordingTestObserver(ctx, new InnerObserver(new NullTestObserver())),
					),
				),
			),
		)

		await (await this.client).reopenPage(this.settings.incognito)
		await this.requestInterceptor.attach(this.client.page)

		this.testCancel = async () => {
			await testObserver.after(this)
		}

		this.failed = false
		this.runningBrowser = null
		this.subTitle = ''

		// await this.observer.attachToNetworkRecorder()

		debug('run() start')

		const { testData } = this.script
		const stepIterator = new StepIterator(this.steps)
		const browser = new Browser<Step>(
			this.script.runEnv.workRoot,
			this.client,
			this.settings,
			this.willRunCommand.bind(this, testObserver),
			this.didRunCommand.bind(this, testObserver),
		)
		let testDataRecord: any
		try {
			this.runningBrowser = browser

			if (this.settings.clearCache) await browser.clearBrowserCache()
			if (this.settings.clearCookies) await browser.clearBrowserCookies()
			if (this.settings.device) await browser.emulateDevice(this.settings.device)
			if (this.settings.userAgent) await browser.setUserAgent(this.settings.userAgent)
			if (this.settings.disableCache) await browser.setCacheDisabled(true)
			if (this.settings.extraHTTPHeaders)
				await browser.setExtraHTTPHeaders(this.settings.extraHTTPHeaders)

			debug('running this.before(browser)')
			await testObserver.before(this)

			debug('Feeding data')
			testDataRecord = testData.feed()
			if (testDataRecord === null) {
				throw new Error('Test data exhausted, consider making it circular?')
			} else {
				debug(JSON.stringify(testDataRecord))
			}

			debug('running hook function: beforeAll')
			await this.runHookFn(this.hook.beforeAll, browser, testDataRecord)

			debug('running steps')
			await stepIterator.run(async (step: Step) => {
				debug('running hook function: beforeEach')
				await this.runHookFn(this.hook.beforeEach, browser, testDataRecord)
				const condition = await stepIterator.callCondition(step, iteration, browser)
				if (!condition) {
					this.summarizeStepBeforeRun(step, iteration)
					return
				}

				const { predicate } = step.options
				if (predicate) {
					const condition = await stepIterator.callPredicate(predicate, browser)
					if (!condition) {
						debug('condition failing')
						return
					}
				}

				browser.customContext = step
				await Promise.race([
					this.runStep(testObserver, browser, step, testDataRecord),
					cancelToken.promise,
				])

				if (cancelToken.isCancellationRequested) return

				if (this.failed) {
					const result = await stepIterator.callRecovery(
						step,
						looper,
						browser,
						this.recoverySteps,
						(this.settings.tries = 0),
					)

					if (result) {
						this.failed = false
					} else {
						throw Error()
					}
				}
				debug('running hook function: afterEach')
				await this.runHookFn(this.hook.afterEach, browser, testDataRecord)
			})
		} catch (err) {
			this.failed = true
			throw err
		} finally {
			await this.afterRunSteps(stepIterator)
			// TODO report skipped steps
			await testObserver.after(this)
			debug('running hook function: afterAll')
			await this.runHookFn(this.hook.afterAll, browser, testDataRecord)
		}
	}

	async afterRunSteps(stepIterator: StepIterator): Promise<void> {
		await this.requestInterceptor.detach(this.client.page)
		this.subTitle = ''
		this.summarizeStepAfterStopRunning(stepIterator)
	}

	summarizeStepBeforeRun(step: Step, iteration: number): void {
		const { skip, pending, once } = step.options
		if (pending || (once && iteration > 1)) {
			this.summaryStep.push({
				stepName: step.name,
				result: StepResult.UNEXECUTED,
			})
			return
		}

		if (skip) {
			this.summaryStep.push({ stepName: step.name, result: StepResult.SKIPPED })
			return
		}
	}

	summarizeStepAfterStopRunning(stepIterator: StepIterator): void {
		const countRepeatStep = (step: Step): boolean => {
			const { repeat } = step.options
			if (repeat) {
				if (repeat.iteration > 0) {
					do {
						repeat.iteration += 1
						this.summaryStep.push({
							stepName: step.name,
							result: StepResult.UNEXECUTED,
						})
					} while (repeat.iteration < repeat.count)
				}
				repeat.iteration = 0
				return true
			}
			return false
		}

		const summarizedUnexecutedStep = (step: Step): void => {
			const countRepeatStepDone = countRepeatStep(step)
			if (countRepeatStepDone) return
			this.summaryStep.push({
				stepName: step.name,
				result: StepResult.UNEXECUTED,
			})
		}
		stepIterator.loopUnexecutedSteps(summarizedUnexecutedStep)
	}

	get currentURL(): string {
		return (this.runningBrowser && this.runningBrowser.url) || ''
	}

	getStepSubtitle(step: Step): string {
		const { repeat } = step.options
		const recoveryTries = step.prop?.recoveryTries
		let subTitle = ''
		if (recoveryTries) {
			subTitle = `${getNumberWithOrdinal(recoveryTries)} recovery`
		}
		if (repeat) {
			let tempTitle = ''
			const { iteration, count } = repeat
			if (iteration >= count || iteration === 0) {
				tempTitle = `${getNumberWithOrdinal(repeat.count)} loop`
			} else {
				tempTitle = `${getNumberWithOrdinal(repeat.iteration)} loop`
			}
			subTitle = subTitle ? `${tempTitle} - ${subTitle}` : tempTitle
		}
		return subTitle
	}

	async runStep(
		testObserver: TestObserver,
		browser: Browser<Step>,
		step: Step,
		testDataRecord: any,
	) {
		let error: Error | null = null
		let errorMessage = 'step error -> failed'
		await testObserver.beforeStep(this, step)
		this.subTitle = this.getStepSubtitle(step)

		const originalBrowserSettings = { ...browser.settings }

		try {
			debug(`Run step: ${step.name}`) // ${step.fn.toString()}`)
			browser.settings = { ...this.settings, ...step.options }
			await step.fn.call(null, browser, testDataRecord)
		} catch (err) {
			error = err
		} finally {
			browser.settings = originalBrowserSettings
			if (step.options.repeat?.iteration !== 0) {
				step.prop = { executed: false }
			} else {
				step.prop = { executed: true }
			}
		}

		if (error !== null) {
			debug('step error')
			if (error.message) {
				errorMessage = error.message
			}
			this.failed = true
			await testObserver.onStepError(this, step, this.liftToStructuredError(error))
			console.group()
			console.group()
			console.log(chalk.red(errorMessage))
			console.groupEnd()
			console.groupEnd()
			this.summaryStep.push({
				stepName: step.name,
				result: StepResult.FAILED,
			})
		} else {
			await testObserver.onStepPassed(this, step)
			this.summaryStep.push({
				stepName: step.name,
				result: StepResult.PASSED,
			})
		}
		await testObserver.afterStep(this, step)

		if (error === null) {
			await this.doStepDelay()
		}

		// await this.syncNetworkRecorder()
		// this.networkRecorder.reset()
		debug('step done')
	}

	liftToStructuredError(error: Error): StructuredError<AnyErrorData> {
		if (error.name.startsWith('AssertionError')) {
			return new StructuredError<AssertionErrorData>(
				error.message,
				{ _kind: 'assertion' },
				error,
			).copyStackFromOriginalError()
		} else if ((error as StructuredError<AnyErrorData>)._structured === 'yes') {
			return error as StructuredError<AnyErrorData>
		} else {
			// catchall - this should trigger a documentation request further up the chain
			return StructuredError.wrapBareError<EmptyErrorData>(error, { _kind: 'empty' }, 'test')
		}
	}

	public get stepNames(): string[] {
		return this.steps.map(s => s.name)
	}

	public async doStepDelay() {
		if (this.skipping || this.settings.stepDelay <= 0) {
			return
		}

		await new Promise(resolve => {
			if (!this.settings.stepDelay) {
				resolve()
				return
			}
			setTimeout(resolve, this.settings.stepDelay * 1e3 || DEFAULT_STEP_WAIT_SECONDS * 1e3)
		})
	}

	public async willRunCommand(testObserver: TestObserver, browser: Browser<Step>, command: string) {
		if (browser.customContext) {
			await testObserver.beforeStepAction(this, browser.customContext, command)
			debug(`Before action: '${command}()' waiting on actionDelay: ${this.settings.actionDelay}`)
		}
	}

	async didRunCommand(testObserver: TestObserver, browser: Browser<Step>, command: string) {
		if (browser.customContext) {
			await testObserver.afterStepAction(this, browser.customContext, command)
		}
	}

	public async takeScreenshot(options?: ScreenshotOptions) {
		if (this.runningBrowser === null) return
		await this.runningBrowser.takeScreenshot(options)
	}

	public async fetchScreenshots(): Promise<string[]> {
		if (this.runningBrowser === null) return []
		return this.runningBrowser.fetchScreenshots()
	}

	/* @deprecated */
	newTrace(step: Step): ObjectTrace {
		return new ObjectTrace(this.script.runEnv.workRoot, step.name)
	}

	private async runHookFn(
		hooks: HookBase[],
		browser: Browser<Step>,
		testDataRecord: any,
	): Promise<void> {
		try {
			for (const hook of hooks) {
				browser.settings = { ...this.settings }
				browser.settings.waitTimeout = hook.waitTimeout
				const hookFn = hook.fn.bind(null, browser, testDataRecord)
				await this.doHookFnWithTimeout(hookFn, hook.waitTimeout)
			}
		} catch (error) {
			throw new Error(error)
		}
	}

	private async doHookFnWithTimeout(fn: any, timeout: number): Promise<any> {
		// Create a promise that rejects in <ms> milliseconds
		const promiseTimeout = new Promise((_, reject) => {
			const id = setTimeout(() => {
				clearTimeout(id)
				reject()
			}, timeout * 1e3)
		})
		// Returns a race between our timeout and the passed in promise
		return Promise.race([fn(), promiseTimeout])
	}
}
