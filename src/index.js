import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('cdiscountCCC')

const baseUrl = 'https://cdiscount.com'
const loginFormUrl =
  'https://order.cdiscount.com/Phone/Account/LoginLight.html?referrer='

class CdiscountContentScript extends ContentScript {
  onWorkerReady() {
    window.addEventListener('DOMContentLoaded', () => {
      const loginForm = document.querySelector('#LoginForm')
      if (loginForm) {
        loginForm.addEventListener('submit', () => {
          this.log('info', 'event submit detected')
          const email = document.querySelector(
            '#CustomerLogin_CustomerLoginFormData_Email'
          )?.value
          const password = document.querySelector(
            '#CustomerLogin_CustomerLoginFormData_Password'
          )?.value
          this.bridge.emit('workerEvent', {
            event: 'loginSubmit',
            payload: { email, password }
          })
        })
      }
      const error = document.querySelector('.error')
      if (error) {
        this.bridge.emit('workerEvent', {
          event: 'loginError',
          payload: { msg: error.innerHTML }
        })
      }
    })
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      const { email, password } = payload || {}
      if (email && password) {
        this.log('info', 'Couple email/password found')
        this.log(
          'info',
          `{email,password} : ${JSON.stringify({ email, password })}`
        )
        this.store.userCredentials = { email, password }
      }
      this.blockWorkerInteractions()
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    // if (!account) {
    //   await this.ensureNotAuthenticated()
    // }
    if (
      !(await this.isElementInWorker(
        '#CustomerLogin_CustomerLoginFormData_Email'
      ))
    ) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    // await this.clickAndWait(logoutLinkSelector, loginLinkSelector)
    return true
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(loginFormUrl)
    await Promise.race([
      this.waitForElementInWorker('#CustomerLogin_CustomerLoginFormData_Email'),
      this.waitForElementInWorker('.leftmenu__logout')
    ])
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async checkAuthenticated() {
    this.log('info', '🤖 checkAuthenticated')
    return Boolean(document.querySelector('.leftmenu__logout'))
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    return {
      sourceAccountIdentifier: 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store.userCredentials) {
      this.log(
        'info',
        `this.store.userCredentials : ${JSON.stringify(
          this.store.userCredentials
        )}`
      )
      await this.saveCredentials(this.store.userCredentials)
    }
  }
}

const connector = new CdiscountContentScript()
connector.init({ additionalExposedMethodsNames: [] }).catch(err => {
  log.warn(err)
})
