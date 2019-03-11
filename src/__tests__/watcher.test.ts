import getPort from 'get-port'
import XrpPlugin from '..'
import test from 'ava'
import { convert, xrp, drop } from '@kava-labs/crypto-rate-utils'
import { RippleAPI } from 'ripple-lib'
import { MemoryStore } from '../utils/store'

test(`channel watcher claims settling channel if it's profitable`, async t => {
  t.plan(1)

  const port = await getPort()

  const clientPlugin = new XrpPlugin({
    role: 'client',
    xrpSecret: process.env.SECRET_A!,
    xrpServer: 'wss://s.altnet.rippletest.net:51233',
    server: `btp+ws://userA:secretA@localhost:${port}`
  })

  const serverStore = new MemoryStore()
  const createServer = async (): Promise<XrpPlugin> => {
    const serverPlugin = new XrpPlugin(
      {
        role: 'server',
        xrpSecret: process.env.SECRET_B!,
        xrpServer: 'wss://s.altnet.rippletest.net:51233',
        channelWatcherInterval: 5000, // Every 5 sec
        debugHostIldcpInfo: {
          assetCode: 'XRP',
          assetScale: 6,
          clientAddress: 'private.xrp'
        },
        port
      },
      {
        store: serverStore
      }
    )

    serverPlugin.registerMoneyHandler(() => Promise.resolve())
    await serverPlugin.connect()

    return serverPlugin
  }

  const serverPlugin = await createServer()
  await clientPlugin.connect()

  // Create channel & send claim to server
  const pluginAccount = await clientPlugin._loadAccount('peer')
  await pluginAccount.fundOutgoingChannel(convert(xrp(1.5), drop()))
  await clientPlugin.sendMoney(convert(xrp(1.5), drop()).toString())

  // Wait for claims to finish processing
  await new Promise(r => setTimeout(r, 2000))

  // Grab the xrpAddress & channelId from client
  const xrpAddress = clientPlugin._xrpAddress
  const { channelId } = pluginAccount.account.outgoing.state!

  // Disconnect the client & server, then start settling the channel
  await clientPlugin.disconnect()
  await serverPlugin.disconnect()

  const api = new RippleAPI({ server: 'wss://s.altnet.rippletest.net:51233' })
  await api.connect()

  const { txJSON } = await api.preparePaymentChannelClaim(xrpAddress, {
    channel: channelId,
    close: true
  })
  const { signedTransaction } = api.sign(txJSON, process.env.SECRET_A!)
  await api.submit(signedTransaction)

  // Start the server back up to make sure the channel watcher claims the channel
  await createServer()

  const checkIfClaimed = async (): Promise<void> => {
    const wasClaimed = await api
      .getPaymentChannel(channelId)
      .then(() => false)
      .catch(err => err.message === 'entryNotFound')

    if (wasClaimed) {
      return t.pass()
    }

    await new Promise(r => setTimeout(r, 1000))
    return checkIfClaimed()
  }

  return checkIfClaimed()
})
