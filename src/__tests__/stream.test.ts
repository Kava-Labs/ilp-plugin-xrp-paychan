import getPort from 'get-port'
import XrpPlugin from '..'
import BigNumber from 'bignumber.js'
import test from 'ava'
import createLogger from 'ilp-logger'
import { convert, xrp, drop } from '@kava-labs/crypto-rate-utils'

test('money can be sent between two peers', async t => {
  const port = await getPort()

  const clientPlugin = new XrpPlugin(
    {
      role: 'client',
      server: `btp+ws://:secret@localhost:${port}`,
      xrpSecret: process.env.SECRET_A!,
      xrpServer: 'wss://s.altnet.rippletest.net:51233'
    },
    {
      log: createLogger('ilp-plugin-xrp:client')
    }
  )

  const serverPlugin = new XrpPlugin(
    {
      role: 'client',
      listener: {
        port,
        secret: 'secret'
      },
      xrpSecret: process.env.SECRET_B!,
      xrpServer: 'wss://s.altnet.rippletest.net:51233'
    },
    {
      log: createLogger('ilp-plugin-xrp:server')
    }
  )

  await Promise.all([serverPlugin.connect(), clientPlugin.connect()])

  const AMOUNT_TO_FUND = convert(xrp(2), drop())
  const AMOUNT_TO_DEPOSIT = convert(xrp(1), drop())

  const SEND_AMOUNT_1 = convert(xrp(2.3), drop())
  const SEND_AMOUNT_2 = convert(xrp(0.5), drop())

  const pluginAccount = await clientPlugin._loadAccount('peer')

  // Open a channel
  await t.notThrowsAsync(
    pluginAccount.fundOutgoingChannel(AMOUNT_TO_FUND, () => Promise.resolve()),
    'successfully opens an outgoing chanenl'
  )

  // Deposit to the channel
  await t.notThrowsAsync(
    pluginAccount.fundOutgoingChannel(AMOUNT_TO_DEPOSIT, () =>
      Promise.resolve()
    ),
    'successfully deposits to the outgoing channel'
  )

  // Ensure the initial claim can be accepted
  serverPlugin.deregisterMoneyHandler()
  await new Promise(async resolve => {
    serverPlugin.registerMoneyHandler(async amount => {
      t.true(
        new BigNumber(amount).isEqualTo(SEND_AMOUNT_1),
        'initial claim is sent and validated successfully between two peers'
      )
      resolve()
    })

    await t.notThrowsAsync(clientPlugin.sendMoney(SEND_AMOUNT_1.toString()))
  })

  // Ensure a greater claim can be accepted
  serverPlugin.deregisterMoneyHandler()
  await new Promise(async resolve => {
    serverPlugin.registerMoneyHandler(async amount => {
      t.true(
        new BigNumber(amount).isEqualTo(SEND_AMOUNT_2),
        'better claim is sent and validated successfully between two peers'
      )
      resolve()
    })

    await t.notThrowsAsync(clientPlugin.sendMoney(SEND_AMOUNT_2.toString()))
  })
})
