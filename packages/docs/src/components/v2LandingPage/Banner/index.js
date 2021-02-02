import React from 'react'
import classnames from 'classnames'
import useThemeContext from '@theme/hooks/useThemeContext'
import './styles.css'

const Banner = () => {
	const { isDarkTheme } = useThemeContext()
	const styleClassName = isDarkTheme ? 'dark' : 'light'
	return (
		<div className="bannerHeader">
			<section className={classnames('container bannerMain', styleClassName)}>
				<div>
					<h1>Flood Element 2.0 is now available!</h1>
					<p>
						In this version, we’re introducing a total transformation of the Element CLI’s look and
						feel for a better developer experience, the core library that Flood Element is built on,
						and many more cool features.
					</p>
				</div>
			</section>
		</div>
	)
}

export default Banner
