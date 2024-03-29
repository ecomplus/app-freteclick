const axios = require('axios')

const instance = axios.create({
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
})

module.exports = ({
  url,
  method,
  token,
  data,
}) => {
  const config = {
    url,
    method,
    headers: {
      'api-token': token,
      accept: 'application/json',
      'Content-Type': 'application/json',
      timeout: 8000
    },
    data
  }

  instance.defaults.baseURL = 'https://api.freteclick.com.br'

  return instance(config)
}
