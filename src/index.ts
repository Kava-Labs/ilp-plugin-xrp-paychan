import { convert, xrp, drop } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import createLogger from 'ilp-logger'
import XrpAccount from './account'
import {
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel
} from './utils/channel'
import ReducerQueue from './utils/queue'
import { MemoryStore, StoreWrapper, Store } from './utils/store'
import { RippleAPI } from 'ripple-lib'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import axios from 'axios'
import express from 'express'
import bodyParser from 'body-parser'
import { promisify } from 'util'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

const DAY_IN_SECONDS = 24 * 60 * 60

export {
  XrpAccount,
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel
}

interface Logger {
  info(...msg: any[]): void
  warn(...msg: any[]): void
  error(...msg: any[]): void
  debug(...msg: any[]): void
  trace(...msg: any[]): void
}

export interface XrpPluginOpts {
  /** Port for local server to interface with connector */
  port: number

  /** URL to send messages */
  sendMessageUrl: string

  /** URL to post incoming settlements */
  receiveMoneyUrl: string

  /**
   * Secret of the XRP account used to send and receive
   * - Corresponds to the XRP address shared with peers
   */
  xrpSecret: string

  /** URI for rippled websocket port to connect to */
  xrpServer?: string

  /** Default amount to fund when opening a new channel or depositing to a depleted channel, in drops of XRP */
  outgoingChannelAmount?: BigNumber.Value

  /**
   * Minimum value of incoming channel in order to _automatically_ fund an outgoing channel to peer, in drops of XRP
   * - Defaults to infinity, which never automatically opens a channel
   * - Will also automatically top-up outgoing channels to the outgoing amount when they
   *   get depleted more than halfway
   */
  minIncomingChannelAmount?: BigNumber.Value

  /** Minimum number of seconds for dispute/expiry period to accept a new incoming channel */
  minIncomingDisputePeriod?: BigNumber.Value

  /** Number of seconds for dispute/expiry period used to create outgoing channels */
  outgoingDisputePeriod?: BigNumber.Value

  /** Number of milliseconds between runs of the channel watcher to check if a dispute was started */
  channelWatcherInterval?: BigNumber.Value

  /** Simple key-value store for persistence of paychan claims and account metadata */
  store?: Store

  /** Logger instance for debugging */
  log?: Logger
}

export const connectXrpPlugin = async ({
  port = 3000,
  sendMessageUrl,
  receiveMoneyUrl,
  xrpSecret,
  xrpServer = 'wss://s1.ripple.com',
  outgoingChannelAmount = convert(xrp(5), drop()),
  minIncomingChannelAmount = Infinity,
  outgoingDisputePeriod = 6 * DAY_IN_SECONDS,
  minIncomingDisputePeriod = 3 * DAY_IN_SECONDS,
  channelWatcherInterval = new BigNumber(60 * 1000), // By default, every 60 seconds
  log = createLogger('ilp-plugin-xrp'),
  store = new MemoryStore()
}: XrpPluginOpts) => {
  const app = express()
  app.use(bodyParser.json())

  const server = app.listen(port)

  const api = new RippleAPI({ server: xrpServer })
  await api.connect()

  // TODO Load old accounts from the DB

  const shared = {
    app,
    server,

    accounts: new Map<string, XrpAccount>(),

    store: new StoreWrapper(store),
    log,

    api,
    xrpSecret: xrpSecret,
    xrpAddress: deriveAddress(deriveKeypair(xrpSecret).publicKey),

    txPipeline: Promise.resolve(),

    outgoingChannelAmount: new BigNumber(outgoingChannelAmount)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN),

    minIncomingChannelAmount: new BigNumber(minIncomingChannelAmount)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN),

    minIncomingDisputePeriod: new BigNumber(minIncomingDisputePeriod)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_CEIL),

    outgoingDisputePeriod: new BigNumber(outgoingDisputePeriod)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN),

    channelWatcherInterval: new BigNumber(channelWatcherInterval)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN),

    queueTransaction<T>(sendTransaction: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        this.txPipeline = this.txPipeline
          .then(sendTransaction)
          .then(resolve, reject)
      })
    },

    async disconnect() {
      // Unload all accounts: stop channel watcher and perform garbage collection
      for (const account of this.accounts.values()) {
        account.unload()
      }

      // Persist store if there are any pending write operations
      await this.store.close()

      await promisify(server.close)()
    }
  }

  const sendMessage = (accountName: string) => (
    data: object
  ): Promise<Buffer> =>
    axios
      .post(sendMessageUrl, {
        accountId: accountName,
        ...data
      })
      .then(res => res.data)

  const receiveMoney = (accountName: string) => (amount: string) =>
    axios.post(receiveMoneyUrl, {
      accountId: accountName,
      amount
    })

  app.post('/createAccount', (req, res) => {
    const accountName = req.body.accountId
    if (shared.accounts.has(accountName)) {
      return res.status(500).send()
    }

    shared.accounts.set(
      accountName,
      new XrpAccount({
        sendMessage: sendMessage(accountName),
        receiveMoney: receiveMoney(accountName),
        accountName,
        accountData: {
          accountName,
          payoutAmount: new BigNumber(0),
          incoming: new ReducerQueue<ClaimablePaymentChannel | undefined>(
            undefined
          ),
          outgoing: new ReducerQueue<PaymentChannel | undefined>(undefined)
        },
        master: shared
      })
    )

    res.sendStatus(200)
  })

  app.post('/receiveMessage', async (req, res) => {
    const { accountId, ...incomingData } = req.body
    const account = shared.accounts.get(accountId)
    if (!account) {
      // TODO Create the account instead of error
      return res.status(500).send()
    }

    const outgoingData = await account.receiveMessage(incomingData)
    res.send(outgoingData)
  })

  app.post('/sendMoney', async (req, res) => {
    const accountName = req.body.accountId
    const account = shared.accounts.get(accountName)
    if (!account) {
      // TODO Create the account instead of error
      return res.status(500).send()
    }

    account.sendMoney(req.body.amount)
    res.sendStatus(200)
  })

  return shared
}
