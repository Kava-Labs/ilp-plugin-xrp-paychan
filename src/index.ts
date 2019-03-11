import { convert, xrp, drop } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { registerProtocolNames } from 'btp-packet'
import debug from 'debug'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import { BtpPacket, IlpPluginBtpConstructorOptions } from 'ilp-plugin-btp'
import XrpAccount, { SerializedAccountData } from './account'
import { XrpClientPlugin } from './plugins/client'
import { XrpServerPlugin, MiniAccountsOpts } from './plugins/server'
import {
  DataHandler,
  Logger,
  MoneyHandler,
  PluginInstance,
  PluginServices
} from './types/plugin'
import {
  updateChannel,
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel,
  deserializePaymentChannel
} from './utils/channel'
import ReducerQueue from './utils/queue'
import { MemoryStore, StoreWrapper } from './utils/store'
import { RippleAPI } from 'ripple-lib'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'

registerProtocolNames(['claim', 'requestClose'])

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

// TODO Should the default handlers return ILP reject packets? Should they error period?

const defaultDataHandler: DataHandler = () => {
  throw new Error('no request handler registered')
}

const defaultMoneyHandler: MoneyHandler = () => {
  throw new Error('no money handler registered')
}

const DAY_IN_SECONDS = 24 * 60 * 60

export {
  XrpAccount,
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel
}

export interface XrpPluginOpts
  extends MiniAccountsOpts,
    IlpPluginBtpConstructorOptions {
  /**
   * "client" to connect to a single peer or parent server that is explicity specified
   * "server" to enable multiple clients to openly connect to the plugin
   */
  role: 'client' | 'server'

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

  /** Maximum allowed amount for incoming packets, in drops of XRP */
  maxPacketAmount?: BigNumber.Value

  /** Number of milliseconds between runs of the channel watcher to check if a dispute was started */
  channelWatcherInterval?: BigNumber.Value
}

export default class XrpPlugin extends EventEmitter2 implements PluginInstance {
  static readonly version = 2
  readonly _plugin: XrpClientPlugin | XrpServerPlugin
  readonly _accounts = new Map<string, XrpAccount>() // accountName -> account
  readonly _xrpSecret: string
  readonly _xrpAddress: string
  readonly _api: RippleAPI
  readonly _outgoingChannelAmount: BigNumber // drops of XRp
  readonly _minIncomingChannelAmount: BigNumber // drops of XRP
  readonly _outgoingDisputePeriod: BigNumber // seconds
  readonly _minIncomingDisputePeriod: BigNumber // seconds
  readonly _maxPacketAmount: BigNumber // drops of XRP
  readonly _maxBalance: BigNumber // drops of XRP
  readonly _channelWatcherInterval: BigNumber // milliseconds
  readonly _store: StoreWrapper
  readonly _log: Logger
  _txPipeline: Promise<void> = Promise.resolve()
  _dataHandler: DataHandler = defaultDataHandler
  _moneyHandler: MoneyHandler = defaultMoneyHandler

  constructor(
    {
      role = 'client',
      xrpSecret,
      xrpServer = 'wss://s1.ripple.com',
      outgoingChannelAmount = convert(xrp(5), drop()),
      minIncomingChannelAmount = Infinity,
      outgoingDisputePeriod = 6 * DAY_IN_SECONDS,
      minIncomingDisputePeriod = 3 * DAY_IN_SECONDS,
      maxPacketAmount = Infinity,
      channelWatcherInterval = new BigNumber(60 * 1000), // By default, every 60 seconds
      // All remaining params are passed to mini-accounts/plugin-btp
      ...opts
    }: XrpPluginOpts,
    { log, store = new MemoryStore() }: PluginServices = {}
  ) {
    super()

    this._store = new StoreWrapper(store)

    this._log = log || createLogger(`ilp-plugin-xrp-${role}`)
    this._log.trace = this._log.trace || debug(`ilp-plugin-xrp-${role}:trace`)

    this._api = new RippleAPI({ server: xrpServer })
    this._xrpSecret = xrpSecret
    this._xrpAddress = deriveAddress(deriveKeypair(xrpSecret).publicKey)

    this._outgoingChannelAmount = convert(xrp(outgoingChannelAmount), drop())
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN)

    this._minIncomingChannelAmount = new BigNumber(minIncomingChannelAmount)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN)
    this._minIncomingDisputePeriod = new BigNumber(minIncomingDisputePeriod)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_CEIL)

    this._outgoingDisputePeriod = new BigNumber(outgoingDisputePeriod)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN)

    this._maxPacketAmount = new BigNumber(maxPacketAmount)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN)

    this._maxBalance = new BigNumber(
      role === 'client' ? Infinity : 0
    ).decimalPlaces(0, BigNumber.ROUND_FLOOR)

    this._channelWatcherInterval = new BigNumber(channelWatcherInterval)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN)

    const loadAccount = (accountName: string) => this._loadAccount(accountName)
    const getAccount = (accountName: string) => {
      const account = this._accounts.get(accountName)
      if (!account) {
        throw new Error(`Account ${accountName} is not yet loaded`)
      }

      return account
    }

    this._plugin =
      role === 'server'
        ? new XrpServerPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )
        : new XrpClientPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async _loadAccount(accountName: string): Promise<XrpAccount> {
    const accountKey = `${accountName}:account`
    await this._store.loadObject(accountKey)

    // TODO Add much more robust deserialization from store
    const accountData = this._store.getObject(accountKey) as (
      | SerializedAccountData
      | undefined)

    // Account data must always be loaded from store before it's in the map
    if (!this._accounts.has(accountName)) {
      const account = new XrpAccount({
        sendMessage: (message: BtpPacket) =>
          this._plugin._sendMessage(accountName, message),
        dataHandler: (data: Buffer) => this._dataHandler(data),
        moneyHandler: (amount: string) => this._moneyHandler(amount),
        accountName,
        accountData: {
          ...accountData,
          accountName,
          receivableBalance: new BigNumber(
            accountData ? accountData.receivableBalance : 0
          ),
          payableBalance: new BigNumber(
            accountData ? accountData.payableBalance : 0
          ),
          payoutAmount: new BigNumber(
            accountData ? accountData.payoutAmount : 0
          ),
          incoming: new ReducerQueue(
            accountData && accountData.incoming
              ? await updateChannel(
                  this._api,
                  deserializePaymentChannel(accountData.incoming)
                )
              : undefined
          ),
          outgoing: new ReducerQueue(
            accountData && accountData.outgoing
              ? await updateChannel(
                  this._api,
                  deserializePaymentChannel(accountData.outgoing)
                )
              : undefined
          )
        },
        master: this
      })

      // Since this account didn't previosuly exist, save it in the store
      this._accounts.set(accountName, account)
      this._store.set('accounts', [...this._accounts.keys()])
    }

    return this._accounts.get(accountName)!
  }

  /**
   * TODO Is this necessary? Does XRP allow multiple transactions simultaneously?
   */
  async _queueTransaction<T>(sendTransaction: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      this._txPipeline = this._txPipeline
        .then(sendTransaction)
        .then(resolve, reject)
    })
  }

  async connect() {
    await this._api.connect()

    // Load all accounts from the store
    await this._store.loadObject('accounts')
    const accounts =
      (this._store.getObject('accounts') as string[] | void) || []

    for (const accountName of accounts) {
      this._log.trace(`Loading account ${accountName} from store`)
      await this._loadAccount(accountName)

      // Throttle loading accounts to ~100 per second
      // Most accounts should shut themselves down shortly after they're loaded
      await new Promise(r => setTimeout(r, 10))
    }

    // Don't allow any incoming messages to accounts until all initial loading is complete
    // (this might create an issue, if an account requires _prefix to be known prior)
    return this._plugin.connect()
  }

  async disconnect() {
    // Triggers claiming of channels on client
    await this._plugin.disconnect()

    // Unload all accounts: stop channel watcher and perform garbage collection
    for (const account of this._accounts.values()) {
      account.unload()
    }

    // Persist store if there are any pending write operations
    await this._store.close()
  }

  isConnected() {
    return this._plugin.isConnected()
  }

  async sendData(data: Buffer) {
    return this._plugin.sendData(data)
  }

  async sendMoney(amount: string) {
    const peerAccount = this._accounts.get('peer')
    if (peerAccount) {
      // If the plugin is acting as a client, enable sendMoney (required for prefunding)
      await peerAccount.sendMoney(amount)
    } else {
      this._log.error(
        'sendMoney is not supported: use plugin balance configuration instead of connector balance for settlement'
      )
    }
  }

  registerDataHandler(dataHandler: DataHandler) {
    if (this._dataHandler !== defaultDataHandler) {
      throw new Error('request handler already registered')
    }

    this._dataHandler = dataHandler
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler() {
    this._dataHandler = defaultDataHandler
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler(moneyHandler: MoneyHandler) {
    if (this._moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler already registered')
    }

    this._moneyHandler = moneyHandler
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler() {
    this._moneyHandler = defaultMoneyHandler
    return this._plugin.deregisterMoneyHandler()
  }
}
