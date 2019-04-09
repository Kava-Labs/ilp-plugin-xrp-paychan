import { AssetUnit, convert, drop, xrp } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import {
  MIME_APPLICATION_JSON,
  MIME_APPLICATION_OCTET_STREAM,
  MIME_TEXT_PLAIN_UTF8,
  TYPE_MESSAGE
} from 'btp-packet'
import { createHmac, randomBytes } from 'crypto'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  Errors,
  errorToReject,
  IlpPrepare,
  IlpReply,
  isFulfill,
  isReject
} from 'ilp-packet'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import libsodium from 'libsodium-wrappers'
import { isValidAddress } from 'ripple-lib/dist/npm/common/schema-validator'
import { promisify } from 'util'
import XrpPlugin from '.'
import { DataHandler, MoneyHandler } from './types/plugin'
import {
  ClaimablePaymentChannel,
  computeChannelId,
  createClaimDigest,
  fetchChannel,
  isDisputed,
  isValidClaimSignature,
  PaymentChannel,
  remainingInChannel,
  sendTransaction,
  SerializedClaim,
  spentFromChannel,
  updateChannel,
  hasClaim
} from './utils/channel'
import ReducerQueue from './utils/queue'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

const CHANNEL_KEY_STRING = 'ilp-plugin-xrp-paychan-channel'

const hmac = (key: string | Buffer, message: string | Buffer) =>
  createHmac('sha256', key)
    .update(message)
    .digest()

const getBtpSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const generateBtpRequestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export const delay = (timeout: number) =>
  new Promise(r => setTimeout(r, timeout))

export const format = (num: AssetUnit) => convert(num, xrp()) + ' xrp'

export interface SerializedAccountData {
  accountName: string
  receivableBalance: string
  payableBalance: string
  payoutAmount: string
  xrpAddress?: string
  incoming?: ClaimablePaymentChannel
  outgoing?: PaymentChannel
}

export interface AccountData {
  /** Hash/account identifier in ILP address */
  accountName: string

  /** Incoming amount owed to us by our peer for their packets we've forwarded */
  receivableBalance: BigNumber

  /** Outgoing amount owed by us to our peer for packets we've sent to them */
  payableBalance: BigNumber

  /**
   * Amount of failed outgoing settlements that is owed to the peer, but not reflected
   * in the payableBalance (e.g. due to sendMoney calls on client)
   */
  payoutAmount: BigNumber

  /**
   * XRP address counterparty should be paid at
   * - Does not pertain to address counterparty sends from
   * - Must be linked for the lifetime of the account
   */
  xrpAddress?: string

  /**
   * Priority FIFO queue for incoming channel state updates:
   * - Validating claims
   * - Watching channels
   * - Claiming chanenls
   */
  incoming: ReducerQueue<ClaimablePaymentChannel | undefined>

  /**
   * Priority FIFO queue for outgoing channel state updates:
   * - Signing claims
   * - Refreshing state after funding transactions
   */
  outgoing: ReducerQueue<PaymentChannel | undefined>
}

enum IncomingTaskPriority {
  ClaimChannel = 1,
  ValidateClaim = 0
}

export default class XrpAccount {
  /** Metadata specific to this account to persist (claims, channels, balances) */
  account: AccountData

  /** Expose access to common configuration across accounts */
  private master: XrpPlugin

  /**
   * Queue for channel state/signing outgoing claims ONLY while a deposit is occuring,
   * enabling them to happen in parallel
   */
  private depositQueue?: ReducerQueue<PaymentChannel | undefined>

  /**
   * Send the given BTP packet message to the counterparty for this account
   * (wraps _call on internal plugin)
   */
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  /** Data handler from plugin for incoming ILP packets */
  private dataHandler: DataHandler

  /** Money handler from plugin for incoming money */
  private moneyHandler: MoneyHandler

  /** Timer/interval for channel watcher to claim incoming, disputed channels */
  private watcher: NodeJS.Timer | null

  /**
   * ed25519 private key unique to this account
   * for signing outgoing payment channel claims
   */
  private privateKey: Uint8Array

  /**
   * ed25519 public key formatted for ripple-lib,
   * used to create new outgoing payment channels
   */
  private publicKey: string

  constructor({
    accountName,
    accountData,
    master,
    sendMessage,
    dataHandler,
    moneyHandler
  }: {
    accountName: string
    accountData: AccountData
    master: XrpPlugin
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
    dataHandler: DataHandler
    moneyHandler: MoneyHandler
  }) {
    this.master = master
    this.sendMessage = sendMessage
    this.dataHandler = dataHandler
    this.moneyHandler = moneyHandler

    this.account = new Proxy(accountData, {
      set: (account, key, val) => {
        this.persistAccountData()
        return Reflect.set(account, key, val)
      }
    })

    // Automatically persist cached channels/claims to the store
    this.account.incoming.on('data', () => this.persistAccountData())
    this.account.outgoing.on('data', () => this.persistAccountData())

    this.watcher = this.startChannelWatcher()

    // Create a unique keypair for signing claims on a per-account basis
    const { privateKey, publicKey } = libsodium.crypto_sign_seed_keypair(
      hmac(this.master._xrpSecret, CHANNEL_KEY_STRING + accountName)
    )
    this.privateKey = privateKey
    this.publicKey =
      'ED' +
      Buffer.from(publicKey)
        .toString('hex')
        .toUpperCase()

    this.autoFundOutgoingChannel().catch(err => {
      this.master._log.error(
        'Error attempting to auto fund outgoing channel: ',
        err
      )
    })
  }

  private persistAccountData(): void {
    this.master._store.set(`${this.account.accountName}:account`, this.account)
  }

  /**
   * Inform the peer what address this instance should be paid at and
   * request the XRP address the peer wants to be paid at
   * - No-op if we already know the peer's address
   */
  private async fetchXrpAddress(): Promise<void> {
    if (typeof this.account.xrpAddress === 'string') return
    try {
      const response = await this.sendMessage({
        type: TYPE_MESSAGE,
        requestId: await generateBtpRequestId(),
        data: {
          protocolData: [
            {
              protocolName: 'info',
              contentType: MIME_APPLICATION_JSON,
              data: Buffer.from(
                JSON.stringify({
                  xrpAddress: this.master._xrpAddress
                })
              )
            }
          ]
        }
      })

      const info = response.protocolData.find(
        (p: BtpSubProtocol) => p.protocolName === 'info'
      )

      if (info) {
        this.linkXrpAddress(info)
      } else {
        this.master._log.debug(
          `Failed to link XRP address: BTP response did not include any 'info' subprotocol data`
        )
      }
    } catch (err) {
      this.master._log.debug(`Failed to exchange XRP addresses: ${err.message}`)
    }
  }

  /**
   * Validate the response to an `info` request and link
   * the provided XRP address to the account, if it's valid
   */
  private linkXrpAddress(info: BtpSubProtocol): void {
    try {
      const { xrpAddress } = JSON.parse(info.data.toString())

      if (typeof xrpAddress !== 'string') {
        return this.master._log.debug(
          `Failed to link XRP address: invalid response, no address provided`
        )
      }

      if (!isValidAddress(xrpAddress)) {
        return this.master._log.debug(
          `Failed to link XRP address: not a valid address`
        )
      }

      const currentAddress = this.account.xrpAddress
      if (currentAddress) {
        // Don't log if it's the same address that's already linked...we don't care
        if (currentAddress.toLowerCase() === xrpAddress.toLowerCase()) {
          return
        }

        return this.master._log.debug(
          `Cannot link XRP address ${xrpAddress} to ${
            this.account.accountName
          }: ${currentAddress} is already linked for the lifetime of the account`
        )
      }

      this.account.xrpAddress = xrpAddress
      this.master._log.debug(
        `Successfully linked XRP address ${xrpAddress} to ${
          this.account.accountName
        }`
      )
    } catch (err) {
      this.master._log.debug(`Failed to link XRP address: ${err.message}`)
    }
  }

  /**
   * Create a channel with the given amount or deposit the given amount to an existing outgoing channel,
   * invoking the authorize callback to confirm the transaction fee
   * - Fund amount is in drops of XRP
   */
  async fundOutgoingChannel(
    value: BigNumber,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ) {
    // TODO Do I need any error handling here!?
    await this.account.outgoing.add(cachedChannel =>
      cachedChannel
        ? this.depositToChannel(cachedChannel, value, authorize)
        : this.openChannel(value, authorize)
    )
  }

  /** Automatically fund a new outgoing channel */
  private async autoFundOutgoingChannel() {
    await this.account.outgoing.add(async cachedChannel => {
      const requiresTopUp =
        !cachedChannel ||
        remainingInChannel(cachedChannel).isLessThan(
          this.master._outgoingChannelAmount.dividedBy(2)
        )

      const incomingChannel = this.account.incoming.state
      const sufficientIncoming = (incomingChannel
        ? incomingChannel.value
        : new BigNumber(0)
      ).isGreaterThanOrEqualTo(this.master._minIncomingChannelAmount)

      if (requiresTopUp && sufficientIncoming) {
        return cachedChannel
          ? this.depositToChannel(
              cachedChannel,
              this.master._outgoingChannelAmount.minus(
                remainingInChannel(cachedChannel)
              )
            )
          : this.openChannel(this.master._outgoingChannelAmount)
      }

      return cachedChannel
    })
  }

  /**
   * Open a channel for the given amount in drops of XRP
   * - Must always be called from a task in the outgoing queue
   */
  private async openChannel(
    value: BigNumber,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ): Promise<PaymentChannel | undefined> {
    await this.fetchXrpAddress()
    if (!this.account.xrpAddress) {
      this.master._log.debug('Failed to open channel: no XRP address is linked')
      return
    }

    const fundAmount = convert(drop(value), xrp()).toFixed(
      6,
      BigNumber.ROUND_DOWN
    )

    const instructions = await this.master._queueTransaction(async () => {
      const {
        txJSON,
        instructions
      } = await this.master._api.preparePaymentChannelCreate(
        this.master._xrpAddress,
        {
          amount: fundAmount,
          destination: this.account.xrpAddress!,
          settleDelay: this.master._outgoingDisputePeriod.toNumber(),
          publicKey: this.publicKey
        }
      )

      const txFee = new BigNumber(instructions.fee)
      await authorize(txFee)

      this.master._log.debug(
        `Opening channel for ${format(drop(value))} and fee of ${format(
          xrp(txFee)
        )}`
      )

      await sendTransaction(txJSON, this.master._api, this.master._xrpSecret)

      return instructions
    })

    const channelId = computeChannelId(
      this.master._xrpAddress,
      this.account.xrpAddress,
      instructions.sequence
    )

    // Ensure that we've successfully fetched the channel details before sending a claim
    // TODO Handle errors from refresh channel
    const newChannel = await this.refreshChannel(
      channelId,
      (channel): channel is PaymentChannel => !!channel
    )()

    // Send a zero amount claim to the peer so they'll link the channel
    const signedChannel = this.signClaim(new BigNumber(0), newChannel)
    this.sendClaim(signedChannel).catch(err =>
      this.master._log.error('Error sending proof-of-channel to peer: ', err)
    )

    this.master._log.debug(
      `Successfully opened channel for ${format(drop(value))}`
    )

    return signedChannel
  }

  /**
   * Deposit the given amount in drops of XRP to the given channel
   * - Must always be called from a task in the outgoing queue
   */
  private async depositToChannel(
    channel: PaymentChannel,
    value: BigNumber,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ): Promise<PaymentChannel | undefined> {
    // To simultaneously send payment channel claims, create a "side queue" only for the duration of the deposit
    this.depositQueue = new ReducerQueue<PaymentChannel | undefined>(channel)

    try {
      const totalNewValue = channel.value.plus(value)
      const isDepositSuccessful = (
        updatedChannel: PaymentChannel | undefined
      ): updatedChannel is PaymentChannel =>
        !!updatedChannel && updatedChannel.value.isEqualTo(totalNewValue)

      const fundAmount = convert(drop(value), xrp()).toFixed(
        6,
        BigNumber.ROUND_DOWN
      )

      await this.master._queueTransaction(async () => {
        const {
          txJSON,
          instructions
        } = await this.master._api.preparePaymentChannelFund(
          this.master._xrpAddress,
          {
            channel: channel.channelId,
            amount: fundAmount
          }
        )

        const txFee = new BigNumber(instructions.fee)
        await authorize(txFee)

        this.master._log.debug(
          `Depositing ${format(drop(value))} to channel for fee of ${format(
            xrp(txFee)
          )}`
        )

        await sendTransaction(txJSON, this.master._api, this.master._xrpSecret)
      })

      // TODO If refreshChannel throws, is the behavior correct?
      const updatedChannel = await this.refreshChannel(
        channel,
        isDepositSuccessful
      )()

      this.master._log.debug('Informing peer of channel top-up')
      this.sendMessage({
        type: TYPE_MESSAGE,
        requestId: await generateBtpRequestId(),
        data: {
          protocolData: [
            {
              protocolName: 'channelDeposit',
              contentType: MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.alloc(0)
            }
          ]
        }
      }).catch(err => {
        this.master._log.error('Error informing peer of channel deposit:', err)
      })

      this.master._log.debug(
        `Successfully deposited ${format(drop(value))} to channel ${
          channel.channelId
        } for total value of ${format(drop(totalNewValue))}`
      )

      const bestClaim = this.depositQueue.clear()
      delete this.depositQueue // Don't await the promise so no new tasks are added to the queue

      // Merge the updated channel state with any claims sent in the side queue
      // TODO Rename this
      const alternativeState = await bestClaim
      return alternativeState
        ? {
            ...updatedChannel,
            signature: alternativeState.signature,
            spent: alternativeState.spent
          }
        : updatedChannel
    } catch (err) {
      this.master._log.error(`Failed to deposit to channel:`, err)

      // Since there's no updated state from the deposit, just use the state from the side queue
      const bestClaim = this.depositQueue!.clear()
      delete this.depositQueue // Don't await the promise so no new tasks are added to the queue

      return bestClaim
    }
  }

  /**
   * Send a settlement/payment channel claim to the peer, in drops of XRP
   *
   * If an amount is specified (e.g. role=client), try to send that amount, plus the amount of
   * settlements that have previously failed.
   *
   * If no amount is specified (e.g. role=server), settle such that 0 is owed to the peer.
   */
  async sendMoney(amount?: string) {
    this.autoFundOutgoingChannel().catch(err =>
      this.master._log.error(
        'Error attempting to auto fund outgoing channel: ',
        err
      )
    )

    this.depositQueue
      ? await this.depositQueue.add(this.createClaim(amount))
      : await this.account.outgoing.add(this.createClaim(amount))
  }

  // TODO I'm not sure the `this` context of this works -- use a single function?
  createClaim = (amount?: string) => async (
    cachedChannel: PaymentChannel | undefined
  ): Promise<PaymentChannel | undefined> => {
    const amountToSend = amount || BigNumber.max(0, this.account.payableBalance)

    this.account.payoutAmount = this.account.payoutAmount.plus(amountToSend)

    const settlementBudget = this.account.payoutAmount
    if (settlementBudget.isLessThanOrEqualTo(0)) {
      return cachedChannel
    }

    if (!cachedChannel) {
      this.master._log.debug(`Cannot send claim: no channel is open`)
      return cachedChannel
    }

    // Used to ensure the claim increment is always > 0
    if (!remainingInChannel(cachedChannel).isGreaterThan(0)) {
      this.master._log.debug(
        `Cannot send claim to: no remaining funds in outgoing channel`
      )
      return cachedChannel
    }

    // Ensures that the increment is greater than the previous claim
    // Since budget and remaining in channel must be positive, claim increment should always be positive
    const claimIncrement = BigNumber.min(
      remainingInChannel(cachedChannel),
      settlementBudget
    )

    this.master._log.info(
      `Settlement attempt triggered with ${this.account.accountName}`
    )

    // Total value of new claim: value of old best claim + increment of new claim
    const value = spentFromChannel(cachedChannel).plus(claimIncrement)

    const updatedChannel = this.signClaim(value, cachedChannel)

    this.master._log.debug(
      `Sending claim for total of ${format(
        drop(value)
      )}, incremented by ${format(drop(claimIncrement))}`
    )

    // Send paychan claim to client, don't await a response
    this.sendClaim(updatedChannel).catch(err =>
      // If they reject the claim, it's not particularly actionable
      this.master._log.debug(
        `Error while sending claim to peer: ${err.message}`
      )
    )

    this.account.payableBalance = this.account.payableBalance.minus(
      claimIncrement
    )

    this.account.payoutAmount = BigNumber.min(
      0,
      this.account.payoutAmount.minus(claimIncrement)
    )

    return updatedChannel
  }

  signClaim(
    value: BigNumber,
    cachedChannel: PaymentChannel
  ): ClaimablePaymentChannel {
    const signature = libsodium.crypto_sign_detached(
      createClaimDigest(cachedChannel.channelId, value.toString()),
      this.privateKey
    )

    return {
      ...cachedChannel,
      spent: value,
      signature: Buffer.from(signature).toString('hex')
    }
  }

  async sendClaim({ channelId, signature, spent }: ClaimablePaymentChannel) {
    const claim = {
      channelId,
      signature,
      value: spent.toString()
    }

    return this.sendMessage({
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
      data: {
        protocolData: [
          {
            protocolName: 'claim',
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }
        ]
      }
    })
  }

  async handleData(message: BtpPacket): Promise<BtpSubProtocol[]> {
    // Link the given XRP address & inform counterparty what address this wants to be paid at
    const info = getBtpSubprotocol(message, 'info')
    if (info) {
      this.linkXrpAddress(info)

      return [
        {
          protocolName: 'info',
          contentType: MIME_APPLICATION_JSON,
          data: Buffer.from(
            JSON.stringify({
              xrpAddress: this.master._xrpAddress
            })
          )
        }
      ]
    }

    // If the peer says they may have deposited, check for a deposit
    const channelDeposit = getBtpSubprotocol(message, 'channelDeposit')
    if (channelDeposit) {
      const cachedChannel = this.account.incoming.state
      if (!cachedChannel) {
        return []
      }

      // Don't block the queue while fetching channel state, since that slows down claim processing
      this.master._log.debug('Checking if peer has deposited to channel')
      const checkForDeposit = async (attempts = 0): Promise<void> => {
        if (attempts > 20) {
          return this.master._log.debug(
            `Failed to confirm incoming deposit after several attempts`
          )
        }

        const updatedChannel = await updateChannel(
          this.master._api,
          cachedChannel
        )

        if (!updatedChannel) {
          return
        }

        const wasDeposit = updatedChannel.value.isGreaterThan(
          cachedChannel.value
        )
        if (!wasDeposit) {
          await delay(250)
          return checkForDeposit(attempts + 1)
        }

        // Rectify the two forked states
        await this.account.incoming.add(async newCachedChannel => {
          // Ensure it's the same channel, except for the value. Otherwise, don't update.
          const isSameChannel =
            newCachedChannel &&
            newCachedChannel.channelId === cachedChannel.channelId
          if (!newCachedChannel || !isSameChannel) {
            this.master._log.debug(
              `Incoming channel was closed while confirming deposit: reverting to old state`
            )

            // Revert to old state
            return newCachedChannel
          }

          // Only update the state with the new value of the channel
          this.master._log.debug('Confirmed deposit to incoming channel')
          return {
            ...newCachedChannel,
            value: BigNumber.max(updatedChannel.value, newCachedChannel.value)
          }
        })
      }

      await checkForDeposit().catch(err => {
        this.master._log.error('Error confirming incoming deposit:', err)
      })

      return []
    }

    // If the peer requests to close a channel, try to close it, if it's profitable
    const requestClose = getBtpSubprotocol(message, 'requestClose')
    if (requestClose) {
      this.master._log.info(
        `Channel close requested for account ${this.account.accountName}`
      )

      await this.claimChannel(false).catch(err =>
        this.master._log.error(
          `Error attempting to claim channel: ${err.message}`
        )
      )

      return [
        {
          protocolName: 'requestClose',
          contentType: MIME_TEXT_PLAIN_UTF8,
          data: Buffer.alloc(0)
        }
      ]
    }

    const claim = getBtpSubprotocol(message, 'claim')
    if (claim) {
      this.master._log.debug(
        `Handling claim for account ${this.account.accountName}`
      )

      // If JSON is semantically invalid, this will throw
      const parsedClaim = JSON.parse(claim.data.toString())

      // TODO Add more robust schema validation
      const hasValidSchema = (o: any): o is SerializedClaim =>
        typeof o.value === 'string' &&
        typeof o.channelId === 'string' &&
        typeof o.signature === 'string'
      if (!hasValidSchema(parsedClaim)) {
        this.master._log.debug('Invalid claim: schema is malformed')
        return []
      }

      await this.account.incoming
        .add(this.validateClaim(parsedClaim))
        .catch(err =>
          // Don't expose internal errors, since it may not have been intentionally thrown
          this.master._log.error('Failed to validate claim: ', err)
        )

      /**
       * Attempt to fund an outgoing channel, if the incoming claim is accepted,
       * the incoming channel has sufficient value, and no existing outgoing
       * channel already exists
       */
      this.autoFundOutgoingChannel().catch(err =>
        this.master._log.error(
          'Error attempting to auto fund outgoing channel: ',
          err
        )
      )

      return []
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    const ilp = getBtpSubprotocol(message, 'ilp')
    if (ilp) {
      try {
        const { amount } = deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)

        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new Errors.AmountTooLargeError('Packet size is too large.', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }

        const newBalance = this.account.receivableBalance.plus(amount)
        if (newBalance.isGreaterThan(this.master._maxBalance)) {
          this.master._log.debug(
            `Cannot forward PREPARE: cannot debit ${format(
              drop(amount)
            )}: proposed balance of ${format(
              drop(newBalance)
            )} exceeds maximum of ${format(drop(this.master._maxBalance))}`
          )
          throw new Errors.InsufficientLiquidityError(
            'Exceeded maximum balance'
          )
        }

        this.master._log.debug(
          `Forwarding PREPARE: Debited ${format(
            drop(amount)
          )}, new balance is ${format(drop(newBalance))}`
        )
        this.account.receivableBalance = newBalance

        const response = await this.dataHandler(ilp.data)
        const reply = deserializeIlpReply(response)

        if (isReject(reply)) {
          this.master._log.debug(
            `Credited ${format(drop(amount))} in response to REJECT`
          )
          this.account.receivableBalance = this.account.receivableBalance.minus(
            amount
          )
        } else if (isFulfill(reply)) {
          this.master._log.debug(
            `Received FULFILL in response to forwarded PREPARE`
          )
        }

        return [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: response
          }
        ]
      } catch (err) {
        return [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: errorToReject('', err)
          }
        ]
      }
    }

    return []
  }

  /**
   * Given an unvalidated claim and the current channel state, return either:
   * (1) the previous state, or
   * (2) new state updated with the valid claim
   */
  validateClaim = (claim: SerializedClaim) => async (
    cachedChannel: ClaimablePaymentChannel | undefined,
    attempts = 0
  ): Promise<ClaimablePaymentChannel | undefined> => {
    // To reduce latency, only fetch channel state if no channel was linked, or there was a possible on-chain deposit
    const shouldFetchChannel =
      !cachedChannel ||
      new BigNumber(claim.value).isGreaterThan(cachedChannel.value)
    // TODO Make sure using the claim id here (in fetchChannel) is safe!
    const updatedChannel = shouldFetchChannel
      ? await fetchChannel(this.master._api, claim.channelId)
      : cachedChannel

    // Perform checks to link a new channel
    if (!cachedChannel) {
      if (!updatedChannel) {
        if (attempts > 20) {
          this.master._log.debug(
            `Invalid claim: channel ${
              claim.channelId
            } doesn't exist, despite several attempts to refresh channel state`
          )
          return cachedChannel
        }

        await delay(250)
        return this.validateClaim(claim)(cachedChannel, attempts + 1)
      }

      // Ensure the channel is to this address
      // (only check for new channels, not per claim, in case the server restarts and changes config)
      const amReceiver = updatedChannel.receiver === this.master._xrpAddress
      if (!amReceiver) {
        this.master._log.debug(
          `Invalid claim: the recipient for new channel ${
            claim.channelId
          } is not ${this.master._xrpAddress}`
        )
        return cachedChannel
      }

      if (isDisputed(updatedChannel)) {
        this.master._log.debug(
          `Invalid claim: new channel ${
            claim.channelId
          } has fixed expiration or the dispute period has already began`
        )
        return cachedChannel
      }

      // Confirm the dispute period for the channel is above the minimum
      const isAboveMinDisputePeriod = updatedChannel.disputeDelay.isGreaterThanOrEqualTo(
        this.master._minIncomingDisputePeriod
      )
      if (!isAboveMinDisputePeriod) {
        this.master._log.debug(
          `Invalid claim: new channel ${
            claim.channelId
          } has dispute period of ${
            updatedChannel.disputeDelay
          } seconds, below floor of ${
            this.master._minIncomingDisputePeriod
          } seconds`
        )
        return cachedChannel
      }
    }
    // An existing claim is linked, so validate this against the previous claim
    else {
      if (!updatedChannel) {
        this.master._log.error(`Invalid claim: channel is unexpectedly closed`)
        return cachedChannel
      }

      // `updatedChannel` is fetched using the id in the claim, so compare
      // against the previously linked channelId in `cachedChannel`
      const wrongChannel = claim.channelId !== cachedChannel.channelId
      if (wrongChannel) {
        this.master._log.debug(
          'Invalid claim: channel is not the previously linked channel'
        )
        return cachedChannel
      }
    }

    /**
     * Ensure the claim is positive or zero
     * - Allow claims of 0 (essentially a proof of channel ownership without sending any money)
     */
    const hasNegativeValue = new BigNumber(claim.value).isNegative()
    if (hasNegativeValue) {
      this.master._log.error(`Invalid claim: value is negative`)
      return cachedChannel
    }

    const isSigned = isValidClaimSignature(claim, updatedChannel)
    if (!isSigned) {
      this.master._log.debug('Invalid claim: signature is invalid')
      return cachedChannel
    }

    const sufficientChannelValue = updatedChannel.value.isGreaterThanOrEqualTo(
      claim.value
    )
    if (!sufficientChannelValue) {
      if (attempts > 20) {
        this.master._log.debug(
          `Invalid claim: value of ${format(
            drop(claim.value)
          )} is above value of channel, despite several attempts to refresh channel state`
        )
        return cachedChannel
      }

      await delay(250)
      return this.validateClaim(claim)(cachedChannel, attempts + 1)
    }

    // Finally, if the claim is new, ensure it isn't already linked to another account
    // (do this last to prevent race conditions)
    if (!cachedChannel) {
      /**
       * Ensure no channel can be linked to multiple accounts
       * - Each channel key is a mapping of channelId -> accountName
       */
      const channelKey = `${claim.channelId}:incoming-channel`
      await this.master._store.load(channelKey)
      const linkedAccount = this.master._store.get(channelKey)
      if (typeof linkedAccount === 'string') {
        this.master._log.debug(
          `Invalid claim: channel ${
            claim.channelId
          } is already linked to a different account`
        )
        return cachedChannel
      }

      this.master._store.set(channelKey, this.account.accountName)
      this.master._log.debug(
        `Incoming channel ${claim.channelId} is now linked to account ${
          this.account.accountName
        }`
      )
    }

    // Cap the value of the credited claim by the total value of the channel
    const claimIncrement = BigNumber.min(
      claim.value,
      updatedChannel.value
    ).minus(cachedChannel ? cachedChannel.spent : 0)

    // Claims for zero are okay, so long as it's new channel (essentially a "proof of channel")
    const isBestClaim = claimIncrement.gt(0)
    if (!isBestClaim && cachedChannel) {
      this.master._log.debug(
        `Invalid claim: value of ${format(
          drop(claim.value)
        )} is less than previous claim for ${format(
          drop(updatedChannel.spent)
        )}`
      )
      return cachedChannel
    }

    // Only perform balance operations if the claim increment is positive
    if (isBestClaim) {
      this.account.receivableBalance = this.account.receivableBalance.minus(
        claimIncrement
      )

      await this.moneyHandler(claimIncrement.toString())
    }

    this.master._log.debug(
      `Accepted incoming claim from account ${
        this.account.accountName
      } for ${format(drop(claimIncrement))}`
    )

    // Start the channel watcher if it wasn't already running
    if (!this.watcher) {
      this.watcher = this.startChannelWatcher()
    }

    return {
      ...updatedChannel,
      channelId: claim.channelId,
      signature: claim.signature,
      spent: new BigNumber(claim.value)
    }
  }

  // Handle the response from a forwarded ILP PREPARE
  handlePrepareResponse(prepare: IlpPrepare, reply: IlpReply) {
    if (isFulfill(reply)) {
      // Update balance to reflect that we owe them the amount of the FULFILL
      const amount = new BigNumber(prepare.amount)

      this.master._log.debug(
        `Received a FULFILL in response to forwarded PREPARE: credited ${format(
          drop(amount)
        )}`
      )
      this.account.payableBalance = this.account.payableBalance.plus(amount)

      this.sendMoney().catch((err: Error) =>
        this.master._log.debug('Error queueing outgoing settlement: ', err)
      )
    } else if (isReject(reply)) {
      this.master._log.debug(
        `Received a ${reply.code} REJECT in response to the forwarded PREPARE`
      )

      // On T04s, send the most recent claim to the peer in case they didn't get it
      const outgoingChannel = this.account.outgoing.state
      if (reply.code === 'T04' && hasClaim(outgoingChannel)) {
        this.sendClaim(outgoingChannel).catch((err: Error) =>
          this.master._log.debug(
            'Failed to send latest claim to peer on T04 error:',
            err
          )
        )
      }
    }
  }

  private startChannelWatcher() {
    const timer: NodeJS.Timeout = setInterval(async () => {
      const cachedChannel = this.account.incoming.state
      // No channel & claim are linked: stop the channel watcher
      if (!cachedChannel) {
        this.watcher = null
        clearInterval(timer)
        return
      }

      const updatedChannel = await updateChannel<ClaimablePaymentChannel>(
        this.master._api,
        cachedChannel
      )

      // If the channel is closed or closing, then add a task to the queue
      // that will update the channel state (for real) and claim if it's closing
      if (!updatedChannel || isDisputed(updatedChannel)) {
        this.claimChannel(true).catch((err: Error) => {
          this.master._log.debug(
            `Error attempting to claim channel or confirm channel was closed: ${
              err.message
            }`
          )
        })
      }
    }, this.master._channelWatcherInterval.toNumber())

    return timer
  }

  claimChannel(
    requireDisputed = false,
    authorize?: (channel: PaymentChannel, fee: BigNumber) => Promise<void>
  ) {
    return this.account.incoming.add(async cachedChannel => {
      if (!cachedChannel) {
        return cachedChannel
      }

      const updatedChannel = await updateChannel(
        this.master._api,
        cachedChannel
      )
      if (!updatedChannel) {
        this.master._log.error(
          `Cannot claim channel ${cachedChannel.channelId} with ${
            this.account.accountName
          }: linked channel is unexpectedly closed`
        )
        return updatedChannel
      }

      const { channelId, spent, signature, publicKey } = updatedChannel

      if (requireDisputed && !isDisputed(updatedChannel)) {
        this.master._log.debug(
          `Won't claim channel ${updatedChannel.channelId} with ${
            this.account.accountName
          }: channel is not disputed`
        )
        return updatedChannel
      }

      // Ripple-lib throws if the claim isn't positive,
      // so otherwise simply don't submit the claim
      const claim = spent.isGreaterThan(0)
        ? {
            publicKey,
            signature: signature.toUpperCase(),
            balance: convert(drop(spent), xrp()).toFixed(
              6,
              BigNumber.ROUND_DOWN
            )
          }
        : {}

      await this.master._queueTransaction(async () => {
        const {
          txJSON,
          instructions
        } = await this.master._api.preparePaymentChannelClaim(
          this.master._xrpAddress,
          {
            channel: channelId,
            close: true,
            ...claim
          }
        )

        const txFee = new BigNumber(instructions.fee)
        if (authorize) {
          const isAuthorized = await authorize(updatedChannel, txFee)
            .then(() => true)
            .catch(() => false)

          if (!isAuthorized) {
            return updatedChannel
          }
        }

        this.master._log.debug(
          `Attempting to claim channel ${channelId} for ${format(drop(spent))}`
        )

        await sendTransaction(txJSON, this.master._api, this.master._xrpSecret)
      })

      // Ensure that we've successfully fetched the updated channel details before sending a new claim
      // TODO Handle errors?
      const closedChannel = await this.refreshChannel(
        updatedChannel,
        (channel): channel is undefined => !channel
      )()

      this.master._log.debug(
        `Successfully claimed incoming channel ${channelId} for ${format(
          drop(spent)
        )}`
      )

      return closedChannel
    }, IncomingTaskPriority.ClaimChannel)
  }

  // Request the peer to claim the outgoing channel
  async requestClose() {
    return this.account.outgoing.add(async cachedChannel => {
      if (!cachedChannel) {
        return
      }

      // TODO The plugin-btp default `responseTimeout` is 35 seconds -- so this might fail/timeout if the tx takes longer to mine!
      return this.sendMessage({
        requestId: await generateBtpRequestId(),
        type: TYPE_MESSAGE,
        data: {
          protocolData: [
            {
              protocolName: 'requestClose',
              contentType: MIME_TEXT_PLAIN_UTF8,
              data: Buffer.alloc(0)
            }
          ]
        }
      })
        .catch(err => {
          this.master._log.debug(
            `Error while requesting peer to claim channel: ${err.message}`
          )
          return cachedChannel
        })
        .then(() => {
          // Ensure that the channel was successfully closed
          // TODO Handle errors?
          const updatedChannel = this.refreshChannel(
            cachedChannel,
            (channel): channel is undefined => !channel
          )()

          this.master._log.debug(
            `Peer successfully closed our outgoing channel ${
              cachedChannel.channelId
            }, returning at least ${format(
              drop(remainingInChannel(cachedChannel))
            )} of collateral`
          )

          return updatedChannel
        })
    })
  }

  // From mini-accounts: invoked on a websocket close or error event
  // From plugin-btp: invoked *only* when `disconnect` is called on plugin
  async disconnect(): Promise<void> {
    // Only stop the channel watcher if the channels were attempted to be closed
    if (this.watcher) {
      clearInterval(this.watcher)
    }
  }

  unload(): void {
    // Stop the channel watcher
    if (this.watcher) {
      clearInterval(this.watcher)
    }

    // Remove event listeners that persisted updated channels/claims
    this.account.outgoing.removeAllListeners()
    this.account.incoming.removeAllListeners()

    // Remove account from store cache
    this.master._store.unload(`${this.account.accountName}:account`)

    // Garbage collect the account at the top-level
    this.master._accounts.delete(this.account.accountName)
  }

  private refreshChannel = <
    TPaymentChannel extends PaymentChannel,
    RPaymentChannel extends TPaymentChannel | undefined
  >(
    channelOrId: string | TPaymentChannel,
    predicate: (
      channel: TPaymentChannel | undefined
    ) => channel is RPaymentChannel
  ) => async (attempts = 0): Promise<RPaymentChannel> => {
    if (attempts > 20) {
      throw new Error(
        'Unable to confirm updated channel state after 20 attempts despite 1 block confirmation'
      )
    }

    const updatedChannel =
      typeof channelOrId === 'string'
        ? ((await fetchChannel(this.master._api, channelOrId).catch(
            // Swallow errors since we'll throw if all attempts fail
            () => undefined
          )) as TPaymentChannel)
        : await updateChannel(this.master._api, channelOrId)

    return predicate(updatedChannel)
      ? // Return the new channel if the state was updated...
        updatedChannel
      : // ...or check again in 1 second if wasn't updated
        delay(1000).then(() =>
          this.refreshChannel(channelOrId, predicate)(attempts + 1)
        )
  }
}
