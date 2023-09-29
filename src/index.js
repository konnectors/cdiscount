import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
import { parse, format } from 'date-fns'
import { fr } from 'date-fns/locale'
const log = Minilog('ContentScript')
Minilog.enable('cdiscountCCC')

// const baseUrl = 'https://cdiscount.com'
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
      const errors = document.querySelectorAll('.c-alert')
      if (errors.length > 1) {
        this.bridge.emit('workerEvent', {
          event: 'loginError',
          payload: { msg: errors[0].innerHTML }
        })
      }
    })
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('debug', 'received loginSubmit, blocking user interactions')
      const { email, password } = payload || {}
      if (email && password) {
        this.log('debug', 'Couple email/password found')
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
    this.log('info', '🤖 ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    if (
      !(await this.isElementInWorker(
        '#CustomerLogin_CustomerLoginFormData_Email'
      ))
    ) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      const credentials = await this.getCredentials()
      if (credentials) {
        try {
          await this.autoLogin(credentials)
          this.log('info', 'Auto login successful')
        } catch (err) {
          this.log(
            'info',
            'Something went wrong with auto login, letting user log in'
          )
          await this.showLoginFormAndWaitForAuthentication()
        }
      } else {
        this.log('info', 'Not authenticated')
        await this.showLoginFormAndWaitForAuthentication()
      }
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
    await this.clickAndWait(
      '.leftmenu__logout > div > a',
      '#CustomerLogin_CustomerLoginFormData_Email'
    )
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

  async autoLogin(credentials) {
    this.log('info', '📍️ autoLogin starts')
    const emailInputSelector = '#CustomerLogin_CustomerLoginFormData_Email'
    const passwordInputSelector =
      '#CustomerLogin_CustomerLoginFormData_Password'
    const submitButton = 'input[type="submit"]'
    await this.waitForElementInWorker(emailInputSelector)
    this.log('debug', 'Fill email field')
    await this.runInWorker('fillText', emailInputSelector, credentials.email)
    await this.waitForElementInWorker(passwordInputSelector)
    this.log('debug', 'Fill password field')
    await this.runInWorker(
      'fillText',
      passwordInputSelector,
      credentials.password
    )
    await this.runInWorker('click', submitButton)
    await this.waitForElementInWorker('.leftmenu__logout')
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
    await this.fetchBills(context)
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

  async fetchBills(context) {
    this.log('info', '📍️ fetchBills starts')
    const numberOfOrders = await this.runInWorker('getOrdersLength')
    const billsToSave = []
    for (let i = 0; i < numberOfOrders; i++) {
      await this.runInWorker('selectOrder', i)
      await Promise.race([
        this.waitForElementInWorker('div[id*="blockSchedule"]'),
        this.runInWorkerUntilTrue({
          method: 'checkOrderSelection'
        })
      ])
      await this.runInWorkerUntilTrue({
        method: 'checkOrderSelection'
      })
      const pageBills = await this.runInWorker('getBills', i)
      billsToSave.push(...pageBills)
    }
    await this.saveBills(billsToSave, {
      context,
      contentType: 'application/pdf',
      fileIdAttributes: ['vendorRef'],
      qualificationLabel: 'other_invoice'
    })
  }

  getOrdersLength() {
    this.log('info', '📍️ getOrdersLength starts')
    const selectElement = document.querySelector(
      '#OrderTrackingFormData_SaleFolderId'
    )
    return selectElement.querySelectorAll('option').length
  }

  async getBills(i) {
    this.log('info', '📍️ getBills starts')
    const selectElement = document.querySelector(
      '#OrderTrackingFormData_SaleFolderId'
    )
    const foundBills = selectElement.querySelectorAll('option')
    const alreadyFetchedBillsValue = []
    const shownBillValue = foundBills[i].getAttribute('value')
    alreadyFetchedBillsValue.push(shownBillValue)

    const ordersElements = document.querySelectorAll('#servGuaranteeDiv')
    const bills = []
    let j = 0
    for (const ordersElement of ordersElements) {
      this.log('info', `Scraping order n°${j + 1}/${ordersElements.length}`)
      const orderCardLeft = ordersElement.querySelector(
        '.czOrderHeaderBlocLeft'
      )
      const orderCardRight = ordersElement.querySelector(
        '.czOrderHeaderBlocRight'
      )
      const orderBillHref = orderCardRight.querySelector(
        'a[title="Imprimer la facture"]'
      )
        ? orderCardRight
            .querySelector('a[title="Imprimer la facture"]')
            .getAttribute('href')
        : null
      if (!orderBillHref) {
        this.log('info', 'No bills to download, jumping this order')
        j++
        continue
      }
      const dateString = orderCardLeft.querySelector('.date > span').textContent
      const parsedDate = parse(dateString, 'dd MMMM yyyy', new Date(), {
        locale: fr
      })
      const orderStatus = orderCardLeft.querySelector(
        '.date > :last-child'
      ).textContent
      const orderReference = orderCardLeft
        .querySelector('.czOrderCustomerReference')
        .textContent.split(':')[1]
        .trim()
      // It has been agreed to just save "Cdiscount" as the vendor for simplicity
      // Keeping this around for later just in case
      // const orderVendorElement = orderCardLeft.querySelector(
      //   '.czOrderCustomerReference'
      // ).nextElementSibling
      // let orderVendorUrl = orderVendorElement.querySelector('a')
      //   ? orderVendorElement.querySelector('a').getAttribute('href')
      //   : baseUrl

      // const orderVendorName = orderVendorElement.querySelector('strong')
      //   ? orderVendorElement.querySelector('strong').textContent
      //   : 'Cdiscount'
      let foundPrice = orderCardLeft
        .querySelector('.czOrderCustomerReference')
        .nextElementSibling.nextSibling.textContent.trim()
        .split('payé')[0]
        .trim()
      let amount
      let currency
      // Sometimes the price is hosted by a different element, we need to check values
      if (!foundPrice || foundPrice === '') {
        const foundVendorPrice = document
          .querySelector('div[id*="blockSchedule"]')
          .textContent.split('payé')[0]
          .trim()
        amount = parseFloat(foundVendorPrice.split('  ')[0].replace(',', '.'))
        currency = foundVendorPrice.split('  ')[1]
      } else {
        amount = parseFloat(foundPrice.split('  ')[0].replace(',', '.'))
        currency = foundPrice.split('  ')[1]
      }
      const fileurl = `https://clients.cdiscount.com${orderBillHref}`
      const filename = `${format(
        parsedDate,
        'yyyy-MM-dd'
      )}_Cdiscount_${amount}${currency}.pdf`
      const oneBill = {
        vendorRef: orderReference,
        date: new Date(parsedDate),
        fileurl,
        filename,
        amount,
        currency,
        vendor: 'Cdiscount',
        fileAttributes: {
          metadata: {
            contentAuthor: 'cdiscount.com',
            issueDate: new Date(),
            datetime: new Date(parsedDate),
            datetimeLabel: 'issueDate',
            carbonCopy: true
          }
        }
      }
      if (dateString === orderStatus) {
        this.log(
          'info',
          'Order too old to have a status, removing orderStatus key'
        )
        delete oneBill.orderStatus
      }
      bills.push(oneBill)
      j++
    }
    document.querySelector('#servGuaranteeDiv').remove()
    return bills
  }

  async selectOrder(i) {
    this.log('info', '📍️ selectOrder starts')
    const form = document.getElementById('OrderTrackingForm')
    const selectElement = document.querySelector(
      '#OrderTrackingFormData_SaleFolderId'
    )
    const foundBills = selectElement.querySelectorAll('option')
    if (!foundBills[i].selected && i > 0) {
      foundBills[i].selected = true
      form.submit()
    }
  }

  async checkOrderSelection() {
    this.log('info', '📍️ checkOrderSelection starts')
    await waitFor(
      () => {
        const referenceElement = document.querySelector(
          '.czOrderCustomerReference'
        )
        let divPriceElement = document.querySelector('div[id*="blockSchedule"]')
        let isPaidPriceString
        if (referenceElement) {
          isPaidPriceString = Boolean(
            referenceElement.nextElementSibling?.nextSibling?.textContent.match(
              '€'
            )
          )
        }
        let isDivPriceElementReady
        if (divPriceElement) {
          isDivPriceElementReady = Boolean(
            divPriceElement.textContent.match('payé')
          )
        }
        if (
          document.querySelector('#servGuaranteeDiv') &&
          isDivPriceElementReady
        ) {
          this.log('info', 'Product loaded - Price div')
          return true
        } else if (
          document.querySelector('#servGuaranteeDiv') &&
          isPaidPriceString
        ) {
          this.log('info', 'Product loaded - Price string')
          return true
        }
        this.log('info', 'Product not loaded yet')
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }
}

const connector = new CdiscountContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getEmailAndBirthDate',
      'getIdentity',
      'getOrdersLength',
      'selectOrder',
      'checkOrderSelection',
      'getBills'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
