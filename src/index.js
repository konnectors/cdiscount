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
    await this.clickAndWait(
      'a[href="https://clients.cdiscount.com/account/customer/accountparameters.html"]',
      '#ParametersBloc'
    )
    await this.runInWorker('getEmailAndBirthDate')
    await this.clickAndWait(
      'a[href="https://clients.cdiscount.com/account/customeraddresses.html"]',
      'a[data-layer-name="layer-update-address-0"]'
    )
    await this.runInWorker('getIdentity', this.store.emailAndBirthDate)
    if (this.store.userIdentity.email[0]?.address) {
      return {
        sourceAccountIdentifier: this.store.userIdentity.email[0].address
      }
    } else {
      throw new Error('No email found for identity')
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store && this.store.userCredentials) {
      this.log('info', 'Saving credentials ...')
      await this.saveCredentials(this.store.userCredentials)
    }
    if (this.store.userIdentity) {
      this.log('info', 'Saving identity ...')
      await this.saveIdentity({ contact: this.store.userIdentity })
    }
    await this.navigateToBillsPage()
    await this.waitForElementInWorker('[pause]')
  }

  async getEmailAndBirthDate() {
    this.log('info', '📍️ getEmailAndBirthDate starts')
    const infosCards = document.querySelectorAll('div[class*="CompteBloc"]')
    const emailAndBirthDate = {}
    for (const infoCard of infosCards) {
      const info = infoCard.querySelector('span')?.textContent
      if (!info || info.includes('*****')) {
        continue
      }
      if (info.includes('@')) {
        this.log('info', 'Email found')
        emailAndBirthDate.email = info.toLowerCase()
      }
      if (info.match(/[\d]{2}\/[\d]{2}\/[\d]{4}/g)) {
        this.log('info', 'bitheDate found')
        emailAndBirthDate.birthDate = info.match(
          /[\d]{2}\/[\d]{2}\/[\d]{4}/g
        )[0]
      }
    }
    await this.sendToPilot({ emailAndBirthDate })
  }

  async getIdentity(emailAndBirthDate) {
    this.log('info', '📍️ getIdentity starts')
    const sharedId = 'CustomerAddressesFormData.'
    const familyName = document.querySelector(
      `input[name="${sharedId}LastName"]`
    )?.value
    const givenName = document.querySelector(
      `input[name="${sharedId}FirstName"]`
    )?.value
    const streetAndStreetNumber = document.querySelector(
      `input[name="${sharedId}Address"]`
    ).value
    const building = document.querySelector(
      `input[name="${sharedId}Build"]`
    )?.value
    const appartement = document.querySelector(
      `input[name="${sharedId}Appartment"]`
    )?.value
    const locality = document.querySelector(
      `input[name="${sharedId}PostalLocality"]`
    )?.value
    const addressComplement = document.querySelector(
      `input[name="${sharedId}AdditionalAddress"]`
    )?.value
    const companyName = document.querySelector(
      `input[name="${sharedId}CompanyName"]`
    )?.value
    const postCode = document.querySelector(
      `input[name="${sharedId}PostalCode"]`
    )?.value
    const city = document.querySelector(`input[name="${sharedId}City"]`)?.value
    const country = document.querySelector(
      `input[name="${sharedId}Country"]`
    )?.value
    const mobileNumber = document.querySelector(
      `input[name="${sharedId}Mobile"]`
    )?.value
    const phoneNumber = document.querySelector(
      `input[name="${sharedId}Phone"]`
    )?.value
    const userIdentity = {
      email: [{ address: emailAndBirthDate.email }],
      name: {
        givenName,
        familyName
      },
      address: [],
      phone: [],
      birthDate: emailAndBirthDate.birthDate
    }
    if (mobileNumber !== '' && mobileNumber !== undefined) {
      userIdentity.phone.push({
        type: 'mobile',
        number: mobileNumber
      })
    }
    if (phoneNumber !== '' && phoneNumber !== undefined) {
      userIdentity.phone.push({
        type: 'home',
        number: phoneNumber
      })
    }
    const foundAddress = this.getAddress({
      streetAndStreetNumber,
      building,
      appartement,
      locality,
      addressComplement,
      companyName,
      postCode,
      city,
      country
    })
    userIdentity.address.push(foundAddress)
    await this.sendToPilot({ userIdentity })
  }

  getAddress(infos) {
    this.log('info', '📍️ getAddress starts')
    let constructedAddress = ''
    const address = {}
    if (
      infos.streetAndStreetNumber !== undefined &&
      infos.streetAndStreetNumber !== ''
    ) {
      constructedAddress += infos.streetAndStreetNumber
      address.street = infos.streetAndStreetNumber
    }
    if (infos.building !== undefined && infos.building !== '') {
      constructedAddress += ` ${infos.building}`
      address.building = infos.building
    }
    if (infos.appartement !== undefined && infos.appartement !== '') {
      constructedAddress += ` ${infos.appartement}`
      address.appartement = infos.appartement
    }
    if (infos.locality !== undefined && infos.locality !== '') {
      constructedAddress += ` ${infos.locality}`
      address.locality = infos.locality
    }
    if (
      infos.addressComplement !== undefined &&
      infos.addressComplement !== ''
    ) {
      constructedAddress += ` ${infos.addressComplement}`
      address.complement = infos.addressComplement
    }
    if (infos.companyName !== undefined && infos.companyName !== '') {
      constructedAddress += ` ${infos.companyName}`
      address.companyName = infos.companyName
    }
    if (infos.postCode !== undefined && infos.postCode !== '') {
      constructedAddress += ` ${infos.postCode}`
      address.postCode = infos.postCode
    }
    if (infos.city !== undefined && infos.city !== '') {
      constructedAddress += ` ${infos.city}`
      address.city = infos.city
    }
    if (infos.country !== undefined && infos.country !== '') {
      constructedAddress += ` ${infos.country}`
      address.country = infos.country
    }
    address.formattedAddress = constructedAddress
    return address
  }

  async navigateToBillsPage() {
    this.log('info', '📍️ navigateToBillsPage starts')
    await this.clickAndWait(
      'a[href="https://clients.cdiscount.com/order/orderstracking.html"]',
      '#orderdetails'
    )
  }
}

const connector = new CdiscountContentScript()
connector
  .init({
    additionalExposedMethodsNames: ['getEmailAndBirthDate', 'getIdentity']
  })
  .catch(err => {
    log.warn(err)
  })
