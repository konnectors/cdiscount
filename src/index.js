process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://c76a294b95744d2cbd8bbf52cb13cd5f:7d6b141aa5fd41b882cf12088683b30a@sentry.cozycloud.cc/51'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  log
  // errors,
  // solveCaptcha
} = require('cozy-konnector-libs')

let request = requestFactory()
const j = request.jar()
request = requestFactory({
  debug: true,
  cheerio: true,
  json: false,
  jar: j,
  insecureHTTPParser: true, // cdiscount sends bad headers sometimes which are not recognized by node
  headers: {
    Referer: 'https://clients.cdiscount.com/account/home.html'
  }
})

module.exports = new BaseKonnector(start)

const vendor = 'cdiscount'
const baseurl = 'https://clients.cdiscount.com'

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching list of orders')
  const saleFolderIDs = await getSaleFolderIDs()
  log('info', 'Fetching orders')
  const orders = await fetchAllOrders(saleFolderIDs)
  log('info', 'Fetching bills')
  const bills = await fetchBills(orders)
  log('info', 'Saving data to Cozy')
  await this.saveBills(bills, fields, {
    linkBankOperations: false,
    fileIdAttributes: ['vendorRef']
  })
}

async function authenticate(username, password) {
  const loginReq =
    'https://order.cdiscount.com/Account/LoginLight.html?referrer='
  const challenge = await fetchChallengeCookie(loginReq)
  const splitChallenge = challenge.split('=')
  j.setCookie(challenge, 'https://order.cdiscount.com')
  // const $blankPageWithCode = await request(
  //   `https://order.cdiscount.com/Account/LoginLight.html?referrer=`
  // )

  // const errorElement = $blankPageWithCode(`table[summary='Reputation Error']`)
  // let challengeCookie

  // if (errorElement.length) {
  //   log('error', errorElement.text())
  //   throw new Error(errors.VENDOR_DOWN)
  // }
  // const challengeMatched = $blankPageWithCode
  //   .html()
  //   .match(/"challenge=([a-zA-Z0-9-_]*)"+/g)
  // if (challengeMatched && challengeMatched[1]) {
  //   log('info', 'found a challenge cookie')
  //   const cookie = challengeMatched[0].replace(/"/g, '')
  //   const cookieSet = request.cookie(`${cookie}`)
  //   challengeCookie = cookieSet
  //   j.setCookie(cookieSet, 'https://order.cdiscount.com')
  // }

  // const $formpage = await request(
  //   `https://order.cdiscount.com/Account/LoginLight.html?referrer=`
  // )
  // const isCaptcha = Boolean($formpage('form#captcha-form').length)
  // if (isCaptcha) {
  //   const websiteKey = $formpage('.g-recaptcha').data('sitekey')
  //   const websiteURL =
  //     'https://order.cdiscount.com/Account/LoginLight.html?referrer='
  //   const captchaToken = await solveCaptcha({ websiteURL, websiteKey })
  //   await request.post(websiteURL, {
  //     form: {
  //       'g-recaptcha-response': captchaToken
  //     }
  //   })
  // }
  await this.signin({
    requestInstance: request,
    url: `https://order.cdiscount.com/Account/LoginLight.html?referrer=`,
    formSelector: '#LoginForm',
    formData: {
      'CustomerLogin.CustomerLoginFormData.Email': username,
      'CustomerLogin.CustomerLoginFormData.Password': password
    },
    Headers: {
      cookie: {
        challenge: `${splitChallenge[1]}`
      }
    },
    validate: (statusCode, $) => {
      const result = $('ul.error').length === 0

      if (!result) {
        log('error', $('ul.error').text())
      }
      return result
    }
  })
}

// There is a form through which we access all the orders.
//
// CAVEAT: we do not have at our disposal an account where several items were
// ordered at the same time.
async function getSaleFolderIDs() {
  const url = `${baseurl}/order/orderstracking.html`
  const challenge = await fetchChallengeCookie(url)
  const splitChallenge = challenge.split('=')
  j.setCookie(challenge, 'https://order.cdiscount.com')

  const $ = await request({
    url: `${baseurl}/order/orderstracking.html`,
    Headers: {
      cookie: {
        challenge: `${splitChallenge[1]}`
      }
    }
  })

  return $('#OrderTrackingFormData_SaleFolderId option')
    .map(function(i, el) {
      return $(el).attr('value')
    })
    .get()
}

async function fetchAllOrders(saleFolderIDs) {
  const orders = []
  for (let saleFolderID of saleFolderIDs) {
    orders.push(await fetchOrder(saleFolderID))
  }

  return orders
}

async function fetchOrder(saleFolderID) {
  // First request to change the order that is currently displayed.
  var options = {
    method: 'POST',
    uri: `${baseurl}/Order/OrderTracking.html`,
    formData: {
      'OrderTrackingFormData.SaleFolderId': saleFolderID
    }
  }

  const $ = await request(options)

  let order = scrape(
    $,
    {
      // CAVEAT: What description should we put in case there are several items
      // linked to a single order?
      // CAVEAT: The description is a sentence, thus it contains spaces. Some
      // processing is required before using it.
      description: {
        sel: '.czPrdDesc strong'
      },
      vendorRef: {
        sel: '.czOrderCustomerReference',
        parse: ref =>
          ref
            .split(':')
            .pop()
            .trim()
      },
      amount: {
        sel: '.czOrderHeaderBloc .czOrderHeaderBlocLeft',
        fn: el => {
          return (
            $(el)[0]
              .children.filter(el => el.type === 'text')
              .map(el => el.data.trim())
              .join('')
              .split('€')[0]
              // The amount is written using the French convention.
              .replace(',', '.')
          )
        }
      },
      billPath: {
        sel: "a[title^='Imprimer']",
        attr: 'href'
      },
      date: {
        sel: `#OrderTrackingFormData_SaleFolderId option[value='${saleFolderID}']`,
        parse: text =>
          text
            .split(' - ')[0]
            .trim()
            .replace(/\//g, '-')
      }
    },
    '#czCt'
  )[0] // scrape returns an array while here there is only one element.

  order.amount = parseFloat(order.amount)
  order.date = normalizeDate(order.date)

  return order
}

async function fetchBills(orders) {
  // Some orders may have been canceled leading to an empty billPath. We filter
  // them out.
  return orders
    .filter(order => order.billPath)
    .map(order => ({
      ...order,
      currency: '€',
      fileurl: `${baseurl}${order.billPath}`,
      vendor,
      requestOptions: {
        jar: j
      },
      filename: `${formatDate(order.date)}-${vendor.toUpperCase()}-${
        order.amount
      }EUR.pdf`,
      fileAttributes: {
        metadata: {
          carbonCopy: true
        }
      }
    }))
}

// In CDiscount the date has the format "DD-MM-YYYY", this function parses it
// and returns a JavaScript date object.
function normalizeDate(date) {
  let [day, month, year] = date.split('-')
  return new Date(`${year}-${month}-${day}`)
}

// Return a string representation of the date that follows this format:
// "YYYY-MM-DD". Leading "0" for the day and the month are added if needed.
function formatDate(date) {
  let month = date.getMonth() + 1
  if (month < 10) {
    month = '0' + month
  }

  let day = date.getDate()
  if (day < 10) {
    day = '0' + day
  }

  let year = date.getFullYear()

  return `${year}${month}${day}`
}

async function fetchChallengeCookie(url) {
  const wantedUrl = await request(`${url}`)
  const parseCookie = wantedUrl.html().match(/"challenge=([a-zA-Z0-9-_]*)"+/g)
  const wantedCookie = parseCookie[0].replace(/"/g, '')
  return wantedCookie
}
