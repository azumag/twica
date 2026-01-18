'use client'

import * as Sentry from '@sentry/nextjs'

const ERROR_TRIGGER_DELAY = 100

export default function TestSentryClient() {
  const triggerError = () => {
    try {
      throw new Error('Test client error from manual trigger')
    } catch (error: unknown) {
      Sentry.captureException(error)
      alert('Error captured in Sentry! Check Sentry dashboard.')
    }
  }

  const triggerUnhandledError = () => {
    setTimeout(() => {
      throw new Error('Test unhandled client error')
    }, ERROR_TRIGGER_DELAY)
  }

  const triggerConsoleError = () => {
    console.error('Test console error')
    Sentry.captureMessage('Test console error', 'warning')
    alert('Console error triggered. Check Sentry dashboard.')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="mt-6 text-3xl font-extrabold text-gray-900">
            Test Sentry Client
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            Test error reporting to Sentry from the client side
          </p>
        </div>
        <div className="mt-8 space-y-4">
          <button
            onClick={triggerError}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Trigger Captured Error
          </button>
          <button
            onClick={triggerUnhandledError}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Trigger Unhandled Error
          </button>
          <button
            onClick={triggerConsoleError}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-yellow-600 hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500"
          >
            Trigger Console Error
          </button>
        </div>
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="text-sm font-medium text-blue-800 mb-2">Instructions</h3>
          <ul className="text-xs text-blue-700 list-disc list-inside space-y-1">
            <li>Click each button to trigger different types of errors</li>
            <li>Check Sentry dashboard for captured events</li>
            <li>Verify event contains correct context and user info</li>
            <li>Verify email and ip_address are removed from user data</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
