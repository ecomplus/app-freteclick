const ecomUtils = require('@ecomplus/utils')
const freteClickApi = require('../../../lib/freteclick/client')

exports.post = async ({ appSdk }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-kangu/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)
  const disableShipping = appData.disable_shipping
  const maxQuotes = appData.max_quote

  let shippingRules
  if (Array.isArray(appData.shipping_rules) && appData.shipping_rules.length) {
    shippingRules = appData.shipping_rules
  } else {
    shippingRules = []
  }

  function hasDecimal (number) {
    return number.toString().includes('.')
  }

  const selectedStoreId = [51316, 51317]

  let token = appData.api_key
  if (!token) {
    // must have configured kangu doc number and token
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: 'Api key or document unset on app hidden data (merchant must configure the app)'
    })
  }

  const marketplace = true
  const noCache = !appData.best_quotation

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const checkZipCode = (rule) => {
    // validate rule zip range
    if (destinationZip && rule.zip_range) {
      const { min, max } = rule.zip_range
      return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
    }
    return true
  }

  let originZip, warehouseCode
  let postingDeadline = appData.posting_deadline
  if (params.from) {
    originZip = params.from.zip
  } else if (Array.isArray(appData.warehouses) && appData.warehouses.length) {
    for (let i = 0; i < appData.warehouses.length; i++) {
      const warehouse = appData.warehouses[i]
      if (warehouse?.zip && checkZipCode(warehouse)) {
        const { code } = warehouse
        if (!code) continue
        if (params.items) {
          const itemNotOnWarehouse = params.items.find(({ quantity, inventory }) => {
            return inventory && Object.keys(inventory).length && !(inventory[code] >= quantity)
          })
          if (itemNotOnWarehouse) continue
        }
        originZip = warehouse.zip
        if (warehouse.posting_deadline?.days) {
          postingDeadline = warehouse.posting_deadline
        }
        if (warehouse.api_key) {
          token = warehouse.api_key
        }
        warehouseCode = code
      }
    }
  }

  if (!originZip) {
    originZip = appData.zip
  }
  originZip = typeof originZip === 'string' ? originZip.replace(/\D/g, '') : ''

  const matchService = (service, name) => {
    const fields = ['service_name', 'service_code']
    for (let i = 0; i < fields.length; i++) {
      if (service[fields[i]]) {
        return service[fields[i]].trim().toUpperCase() === name.toUpperCase()
      }
    }
    return true
  }

  // search for configured free shipping rule
  if (Array.isArray(appData.free_shipping_rules)) {
    for (let i = 0; i < appData.free_shipping_rules.length; i++) {
      const rule = appData.free_shipping_rules[i]
      if (rule && checkZipCode(rule)) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }
  if (!originZip) {
    // must have configured origin zip code to continue
    return res.status(409).send({
      error: 'CALCULATE_ERR',
      message: 'Zip code is unset on app hidden data (merchant must configure the app)'
    })
  }

  const isVidro = params.items.some(({ name }) => {
    return name.includes('crista') || name.includes('espelh') || name.includes('vidr')
  })
  const restrict = isVidro ? 'Vidro' : 'Móveis'
  if (params.items) {
    let finalWeight = 0
    let cartSubtotal = 0
    const packages = []
    params.items.forEach((item) => {
      const { quantity, dimensions, weight } = item
      // parse cart items to kangu schema
      let kgWeight = 0
      if (weight && weight.value) {
        switch (weight.unit) {
          case 'g':
            kgWeight = weight.value / 1000
            break
          case 'mg':
            kgWeight = weight.value / 1000000
            break
          default:
            kgWeight = weight.value
        }
      }

      finalWeight += (quantity * kgWeight)
      cartSubtotal += (quantity * ecomUtils.price(item))
      const isConexao = selectedStoreId.includes(storeId)
      const cmDimensions = {}
      if (dimensions) {
        for (const side in dimensions) {
          const dimension = dimensions[side]
          if (dimension && dimension.value) {
            switch (dimension.unit) {
              case 'cm':
                if (isConexao && hasDecimal(dimension.value)) {
                  cmDimensions[side] = dimension.value
                } else {
                  cmDimensions[side] = dimension.value / 100
                }
                break
              case 'mm':
                cmDimensions[side] = dimension.value / 1000
                break
              default:
                cmDimensions[side] = dimension.value
            }
          }
        }
      }
      packages.push({
        weight: kgWeight || 5,
        height: cmDimensions.height || 0.5,
        width: cmDimensions.width || 0.30,
        depth: cmDimensions.length || 0.30,
        qtd: quantity
      })
    })
    const productType = restrict

    const productTotalPrice = cartSubtotal || 1
    const quoteType = 'full'

    const body = {
      destination: destinationZip,
      origin: originZip,
      productType,
      productTotalPrice,
      quoteType,
      marketplace,
      noCache,
      packages,
      app: 'E-Com Plus'
    }

    if (disableShipping) {
      body.denyCarriers = disableShipping.trim().split(',')
    }
    return freteClickApi({
      url: '/quotes',
      method: 'post',
      token,
      data: body,
      timeout: (params.is_checkout_confirmation ? 8000 : 5000)
    }).then(({ data, status }) => {
      let result
      if (typeof data === 'string') {
        try {
          result = JSON.parse(data)
        } catch (e) {
          console.log('> Frete Click invalid JSON response', data)
          return res.status(409).send({
            error: 'CALCULATE_INVALID_RES',
            message: data
          })
        }
      } else {
        result = data?.response?.data?.order?.quotes
      }

      if (result && Number(status) === 200 && Array.isArray(result)) {
        // success response
        const orderId = data.response.data.order.id
        let lowestPriceShipping
        result.forEach((freteClickService, index) => {
          if (maxQuotes && index >= maxQuotes) return
          const { carrier } = freteClickService
          // parse to E-Com Plus shipping line object
          const serviceCode = carrier && carrier.id
          const price = freteClickService.total

          // push shipping service object to response
          const shippingLine = {
            from: {
              ...params.from,
              zip: originZip
            },
            to: params.to,
            price,
            total_price: price,
            discount: 0,
            delivery_time: {
              days: parseInt(freteClickService.deliveryDeadline, 10),
              working_days: true
            },
            delivery_instructions: 'Gestão Logística via Frete Click',
            posting_deadline: {
              days: 3,
              ...postingDeadline
            },
            package: {
              weight: {
                value: finalWeight,
                unit: 'kg'
              }
            },
            custom_fields: [
              {
                field: 'freteclick_id',
                value: freteClickService.id
              },
              {
                field: 'freteclick_order_id',
                value: orderId
              }
            ],
            warehouse_code: warehouseCode,
            flags: ['freteclick-ws', `freteclick-${serviceCode}`.substr(0, 20)]
          }
          if (!lowestPriceShipping || lowestPriceShipping.price > price) {
            lowestPriceShipping = shippingLine
          }
          if (shippingLine.posting_deadline?.days >= 0) {
            shippingLine.posting_deadline.days += parseInt(freteClickService.retrieveDeadline, 10)
          }

          // check for default configured additional/discount price
          if (appData.additional_price) {
            if (appData.additional_price > 0) {
              shippingLine.other_additionals = [{
                tag: 'additional_price',
                label: 'Adicional padrão',
                price: appData.additional_price
              }]
            } else {
              // negative additional price to apply discount
              shippingLine.discount -= appData.additional_price
            }
            // update total price
            shippingLine.total_price += appData.additional_price
          }

          // search for discount by shipping rule
          const shippingName = carrier.alias || carrier.name
          if (Array.isArray(shippingRules)) {
            for (let i = 0; i < shippingRules.length; i++) {
              const rule = shippingRules[i]
              if (
                rule &&
                matchService(rule, shippingName) &&
                checkZipCode(rule) &&
                !(rule.min_amount > params.subtotal)
              ) {
                // valid shipping rule
                if (rule.discount && rule.service_name) {
                  let discountValue = rule.discount.value
                  if (rule.discount.percentage) {
                    discountValue *= (shippingLine.total_price / 100)
                  }
                  shippingLine.discount += discountValue
                  shippingLine.total_price -= discountValue
                  if (shippingLine.total_price < 0) {
                    shippingLine.total_price = 0
                  }
                  break
                }
              }
            }
          }

          // change label
          let label = shippingName
          if (appData.services && Array.isArray(appData.services) && appData.services.length) {
            const service = appData.services.find(service => {
              return service && matchService(service, label)
            })
            if (service && service.label) {
              label = service.label
            }
          }

          const serviceCodeName = shippingName.replaceAll(' ', '_').toLowerCase()
          response.shipping_services.push({
            label,
            carrier: freteClickService.name,
            service_name: serviceCodeName || shippingName,
            service_code: serviceCode,
            shipping_line: shippingLine
          })
        })

        if (lowestPriceShipping) {
          const { price } = lowestPriceShipping
          const discount = typeof response.free_shipping_from_value === 'number' &&
            response.free_shipping_from_value <= cartSubtotal
            ? price
            : 0
          if (discount) {
            lowestPriceShipping.total_price = price - discount
            lowestPriceShipping.discount = discount
          }
        }
        res.send(response)
      } else {
        // console.log(data)
        const err = new Error('Invalid Frete Click calculate response', storeId, JSON.stringify(body))
        err.response = { data, status }
        throw err
      }
    })
      .catch(err => {
        let { message, response } = err
        console.log('>> Frete Click message error', message)
        console.log('>> Frete Click response error', response)

        if (response && response.data) {
          // try to handle Frete Click error response
          const { data } = response
          let result
          if (typeof data === 'string') {
            try {
              result = JSON.parse(data)
            } catch (e) {
            }
          } else {
            result = data
          }
          if (result && result.data) {
            // Frete Click error message
            return res.status(409).send({
              error: 'CALCULATE_FAILED',
              message: result.data
            })
          }
          message = `${message} (${response.status})`
        } else {
          console.error(err)
        }
        console.log('error', err)
        return res.status(409).send({
          error: 'CALCULATE_ERR',
          message
        })
      })
  } else {
    res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  res.send(response)
}
