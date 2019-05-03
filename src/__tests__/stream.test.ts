import { connectXrpPlugin } from '..'
import test from 'ava'
import createLogger from 'ilp-logger'
import { convert, xrp, drop } from '@kava-labs/crypto-rate-utils'
import axios from 'axios'
import express from 'express'
import bodyParser from 'body-parser'

test('money can be sent between two peers', async t => {
  const ALICE_URL = 'http://localhost:3000'
  const BOB_URL = 'http://localhost:3001'
  const RECEIVE_MONEY_URL = 'http://localhost:3002/receiveMoney'

  const AMOUNT_TO_FUND = convert(xrp(4), drop())
  const SEND_AMOUNT_1 = convert(xrp(1.3), drop())
  const SEND_AMOUNT_2 = convert(xrp(0.5), drop())

  await connectXrpPlugin({
    port: 3000,
    receiveMoneyUrl: 'this_should_never_be_called',
    sendMessageUrl: `${BOB_URL}/receiveMessage`,
    minIncomingChannelAmount: 0,
    outgoingChannelAmount: AMOUNT_TO_FUND,
    xrpSecret: process.env.SECRET_A!,
    xrpServer: 'wss://s.altnet.rippletest.net:51233',
    log: createLogger('ilp-plugin-xrp:alice')
  })

  await connectXrpPlugin({
    port: 3001,
    receiveMoneyUrl: RECEIVE_MONEY_URL,
    sendMessageUrl: `${ALICE_URL}/receiveMessage`,
    minIncomingChannelAmount: 0,
    outgoingChannelAmount: AMOUNT_TO_FUND,
    xrpSecret: process.env.SECRET_B!,
    xrpServer: 'wss://s.altnet.rippletest.net:51233',
    log: createLogger('ilp-plugin-xrp:bob')
  })

  // Create the accounts
  // (since this is direct settlement engine to settlement engine, they need to use the same accountId
  //  but this isn't necessary if used with connectors)

  await axios.post(`${ALICE_URL}/createAccount`, {
    accountId: 'peer'
  })

  await axios.post(`${BOB_URL}/createAccount`, {
    accountId: 'peer'
  })

  const testSendReceiveMoney = (amount: string, assertionMessage: string) =>
    new Promise(resolve => {
      const app = express()
      app.use(bodyParser.json())
      const server = app.listen(3002)

      app.post('/receiveMoney', (req, res) => {
        t.is(req.body.amount, amount, assertionMessage)
        res.sendStatus(200)

        server.close()
        resolve()
      })

      axios.post(`${ALICE_URL}/sendMoney`, {
        accountId: 'peer',
        amount
      })
    })

  // Ensure the initial claim can be accepted
  await testSendReceiveMoney(
    SEND_AMOUNT_1.toString(),
    'initial claim is sent and validated successfully between two peers'
  )

  // Ensure a greater claim can be accepted
  await testSendReceiveMoney(
    SEND_AMOUNT_2.toString(),
    'better claim is sent and validated successfully between two peers'
  )
})
