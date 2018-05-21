const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

module.exports = new BaseKonnector(start)

const vendor = 'cdiscount'
const baseurl = 'https://clients.cdiscount.com'

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching list of orders')
  const saleFolderIDs = await getSaleFolderIDs()
  log('info', 'Fetching orders')
  const orders = await fetchAllOrders(saleFolderIDs)
  log('info', 'Fetching bills')
  const bills = await fetchBills(orders)
  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields.folderPath, {
    identifiers: [vendor]
  })
}

async function authenticate(username, password) {
  const url = `${baseurl}/Account/Login.html`
  // The cookie "__RequestVerificationToken" is required to log in. This first
  // request is here for that reason.
  await request(url)

  return signin({
    url,
    formSelector: '#loginForm',
    formData: {
      'LoginViewData.CustomerLoginFormData.Email': username,
      'LoginViewData.CustomerLoginFormData.Password': password
    },

    validate: (statusCode, $) => {
      if ($(`a[title='disconnect']`).length === 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', $('.error').text())
        return false
      }
    }
  })
}

// There is a form through which we access all the orders.
//
// CAVEAT: we do not have at our disposal an account where several items were
// ordered at the same time.
async function getSaleFolderIDs() {
  const $ = await request(`${baseurl}/order/orderstracking.html`)

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
      amount: {
        sel: '.czOrderHeaderBlocLeft p',
        parse: text =>
          text
            .split('€')[0]
            .trim()
            // The amount is written using the French convention.
            .replace(',', '.')
      },
      billPath: {
        sel: "a[title='Facture']",
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
  return orders.filter(order => order.billPath).map(order => ({
    ...order,
    currency: '€',
    fileurl: `${baseurl}${order.billPath}`,
    vendor,
    filename: `${formatDate(order.date)}-${vendor.toUpperCase()}-${
      order.amount
    }EUR.pdf`,
    metadata: {
      importDate: new Date(),
      version: 1
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
