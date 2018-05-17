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

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  const saleFolderIDs = await getSaleFolderIDs()
  log('info', `Found ${saleFolderIDs.length} document(s)`)
  const orders = await fetchAllOrders(saleFolderIDs)

  const bills = await fetchBills(orders)
  log('info', `Saving ${bills.length} bills`)

  await saveBills(bills, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank
    // operations. These identifiers should be at least a word found in the
    // title of a bank operation related to this bill. It is not case sensitive.
    identifiers: [vendor]
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  const url = `${baseurl}/Account/Login.html`
  await request(url)

  return signin({
    url,
    formSelector: '#loginForm',
    formData: {
      'LoginViewData.CustomerLoginFormData.Email': username,
      'LoginViewData.CustomerLoginFormData.Password': password
    },

    // the validate function will check if
    validate: (statusCode, $) => {
      // The login in toscrape.com always works excepted when no password is set
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
  for (saleFolderID of saleFolderIDs) {
    orders.push(await fetchOrder(saleFolderID))
  }

  log('debug', orders)

  return orders
}

async function fetchOrder(saleFolderID) {
  log('info', `fetching order ${saleFolderID}`)

  var options = {
    method: 'POST',
    uri: `${baseurl}/Order/OrderTracking.html`,
    formData: {
      'OrderTrackingFormData.SaleFolderId': saleFolderID
    }
  }

  const $ = await request(options)

  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  return scrape(
    $,
    {
      description: {
        sel: '.czPrdDesc strong'
      },
      amount: {
        sel: '.czOrderHeaderBlocLeft p',
        parse: text => text.split('€')[0].trim()
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
  )[0]
}

async function fetchBills(orders) {
  log('debug', `${baseurl}${orders[0].billPath}`)
  return orders.filter(order => order.billPath).map(doc => ({
    ...doc,
    currency: '€',
    fileurl: `${baseurl}${doc.billPath}`,
    vendor,
    filename: `${vendor}-${doc.date}-${doc.amount}-${doc.description}.pdf`,
    metadata: {
      // it can be interesting that we add the date of import. This is not
      // mandatory but may be usefull for debugging or data migration
      importDate: new Date(),
      // document version, usefull for migration after change of document structure
      version: 1
    }
  }))
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.trim().replace('£', ''))
}
