import { convert, drop, xrp } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { createHash } from 'crypto'
import createLogger from 'ilp-logger'
import libsodium from 'libsodium-wrappers'
import { RippleAPI, FormattedPaymentChannel } from 'ripple-lib'
import { Outcome } from 'ripple-lib/dist/npm/transaction/types'
import { delay } from '../account'
const addressCodec = require('ripple-address-codec')

const log = createLogger('ilp-plugin-xrp:tx-submitter')

export interface PaymentChannel {
  /** UNIX timestamp in milliseconds when channel state was last fetched */
  lastUpdated: number
  /** Unique identifier for this specific channel */
  channelId: string
  /** XRP address of the receiver in the channel */
  receiver: string
  /** XRP address of the sender in the channel */
  sender: string
  /** Public key of the key pair the sender may use to sign claims against this channel */
  publicKey: string
  /**
   * Amount of seconds the sender must wait before
   * closing the channel if it has unclaimed XRP
   */
  disputeDelay: BigNumber
  /**
   * UNIX timestamp when the channel expires and can be closed by the sender
   * - Channels can expire after the planned expiration time,
   *   which is immutable after creating the channel (optional)
   * - Or, channels that are disputed expire after the dispute
   *   delay has ended (triggered by sender, but can be extended)
   * - This represents the minimum/earliest expiration of the two
   * - Not defined if the channel has no planned expiration and
   *   is not currently disputed
   * - https://developers.ripple.com/use-payment-channels.html
   */
  expiresAt?: BigNumber
  /** Total collateral the sender added to the channel, in drops of XRP */
  value: BigNumber
  /**
   * Amount claimed by the receiver, checkpointed on the ledger,
   * which is delivered when the channel closes, in drops of XRP
   */
  balance: BigNumber
  /**
   * Value of the claim/amount that can be claimed in drops of XRP
   * - If no claim signature is included, the value defaults to 0
   */
  spent: BigNumber
  /** Valid signature to claim the channel */
  signature?: string
}

export interface ClaimablePaymentChannel extends PaymentChannel {
  /** Valid signature to claim the channel */
  signature: string
}

export interface SerializedClaim {
  /** Unique identifier for this specific channel */
  channelId: string
  /** Signature from the account that created the channel */
  signature: string
  /** Total amount that can be claimed, in drops of XRP */
  value: string
}

// TODO The param isn't really a PaymentChannel; it's serialized so all the bignumbers are strings
export const deserializePaymentChannel = <
  TPaymentChannel extends PaymentChannel
>(
  channel: TPaymentChannel
): TPaymentChannel => ({
  ...channel,
  disputeDelay: new BigNumber(channel.disputeDelay),
  expiresAt: channel.expiresAt
    ? new BigNumber(channel.expiresAt)
    : channel.expiresAt,
  value: new BigNumber(channel.value),
  balance: new BigNumber(channel.balance),
  spent: new BigNumber(channel.spent)
})

// TODO Add sanity checks to ensure it's *actually* the same channel?
// TODO Is this essentially, update paychan *with* claim, whereas fetch channel is update paychan *without* claim?
export const updateChannel = async <TPaymentChannel extends PaymentChannel>(
  api: RippleAPI,
  cachedChannel: TPaymentChannel
): Promise<TPaymentChannel | undefined> =>
  fetchChannel(api, cachedChannel.channelId)
    .then(
      updatedChannel =>
        updatedChannel && {
          ...cachedChannel,
          ...updatedChannel,
          spent: cachedChannel.spent,
          signature: cachedChannel.signature
        }
    )
    .catch(() => cachedChannel)

export const fetchChannel = (
  api: RippleAPI,
  channelId: string
): Promise<PaymentChannel | undefined> =>
  api
    .getPaymentChannel(channelId)
    .then(channel => {
      const {
        account,
        destination,
        amount,
        balance,
        settleDelay,
        expiration,
        cancelAfter,
        publicKey
      } = channel as FormattedPaymentChannel

      const disputeExpiration = expiration ? Date.parse(expiration) : Infinity
      const immutableExpiration = cancelAfter
        ? Date.parse(cancelAfter)
        : Infinity
      const expiresAt = BigNumber.min(disputeExpiration, immutableExpiration)

      return {
        lastUpdated: Date.now(),
        channelId,
        receiver: destination,
        sender: account,
        publicKey,
        disputeDelay: new BigNumber(settleDelay),
        expiresAt: expiresAt.isEqualTo(Infinity) ? undefined : expiresAt,
        balance: convert(xrp(balance), drop()).dp(0, BigNumber.ROUND_DOWN),
        value: convert(xrp(amount), drop()).dp(0, BigNumber.ROUND_DOWN),
        spent: new BigNumber(0)
      }
    })
    .catch(err => {
      if (err.message === 'entryNotFound') {
        return undefined
      } else {
        throw err
      }
    })

export const sendTransaction = async (
  txJSON: string,
  api: RippleAPI,
  xrpSecret: string
): Promise<Outcome> => {
  /*
   * Per https://github.com/ripple/ripple-lib/blob/develop/docs/index.md#transaction-instructions:
   *
   * By omitting maxLedgerVersion instruction, the "preparePaymentChannel*"
   * methods automatically supply a maxLedgerVersion equal to the current ledger plus 3
   */
  const { id, signedTransaction } = api.sign(txJSON, xrpSecret)

  /**
   * Per https://developers.ripple.com/get-started-with-rippleapi-for-javascript.html:
   *
   * The tentative result should be ignored. Transactions that succeed here can ultimately fail,
   * and transactions that fail here can ultimately succeed.
   */
  await api.submit(signedTransaction)

  // Refresh to ensure this tx was included in a validated ledger
  const checkForTx = (attempts = 0): Promise<Outcome> =>
    api
      .getTransaction(id)
      .then(({ outcome }) => {
        if (outcome.result !== 'tesSUCCESS') {
          throw new Error(`Error verifying tx: ${outcome.result}`)
        }

        log.debug(`Transaction ${id} was included in a validated ledger`)
        return outcome
      })
      /**
       * Ripple-lib throws if the tx isn't from a validated ledger:
       * https://github.com/ripple/ripple-lib/blob/181cfd69de74454f1024b77dffdeb1363cbc07c1/src/ledger/transaction.ts#L86
       */
      .catch(async (err: Error) => {
        if (attempts > 50) {
          log.debug(
            `Failed to verify transaction, despite several attempts: ${
              err.message
            }`
          )

          throw err
        }

        const shouldRetry =
          err instanceof api.errors.MissingLedgerHistoryError ||
          err instanceof api.errors.NotFoundError
        if (shouldRetry) {
          await delay(200)
          return checkForTx(attempts + 1)
        }

        throw err
      })

  return checkForTx()
}

// TODO We *should* be able to get the id from the logs of getTransaction, instead of generating it! (There's a `channelLogs` property)
export const computeChannelId = (
  senderAddress: string,
  receiverAddress: string,
  sequence: number
) => {
  /**
   * "A Sequence number is a 32-bit unsigned integer used to identify a transaction or Offer relative to a specific account."
   * - https://developers.ripple.com/basic-data-types.html
   * - Ripple-lib should ensure this a 32-bit uint
   */
  const sequenceBuffer = Buffer.alloc(4)
  sequenceBuffer.writeUInt32BE(sequence, 0)

  const preimage = Buffer.concat([
    Buffer.from('\0x', 'ascii'),
    Buffer.from(addressCodec.decodeAccountID(senderAddress)),
    Buffer.from(addressCodec.decodeAccountID(receiverAddress)),
    sequenceBuffer
  ])

  return createHash('sha512')
    .update(preimage)
    .digest()
    .slice(0, 32)
    .toString('hex')
    .toUpperCase()
}

export const hasClaim = (
  channel?: PaymentChannel
): channel is ClaimablePaymentChannel => !!channel && !!channel.signature

export const spentFromChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.spent : new BigNumber(0)

export const remainingInChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.value.minus(channel.spent) : new BigNumber(0)

export const isDisputed = (channel: PaymentChannel): boolean =>
  !!channel.expiresAt

export const isValidClaimSignature = (
  claim: SerializedClaim,
  channel: PaymentChannel
): boolean =>
  libsodium.crypto_sign_verify_detached(
    Buffer.from(claim.signature, 'hex'),
    createClaimDigest(claim.channelId, claim.value),
    Buffer.from(channel.publicKey.substring(2), 'hex')
  )

/**
 * TODO Is all this necessary? Is there a simpler BigNumber.toBuffer/toUInt64BE?
 * (for validating claims, the value will be enforced by channel value on the ledger, which provides some limit)
 */

const MAX_U32 = '4294967296'
const MAX_U64 = '18446744073709551616'
const toU64BE = (n: BigNumber.Value) => {
  const bn = new BigNumber(n)
  if (bn.lt(0) || bn.gte(MAX_U64)) {
    throw new Error('number out of range for u64. n=' + n)
  }

  const buf = Buffer.alloc(8)
  const high = bn.dividedBy(MAX_U32)
  const low = bn.modulo(MAX_U32)
  buf.writeUInt32BE(high.toNumber(), 0)
  buf.writeUInt32BE(low.toNumber(), 4)
  return buf
}

export const createClaimDigest = (channelId: string, value: string) =>
  Buffer.concat([
    Buffer.from('CLM\0'),
    Buffer.from(channelId, 'hex'),
    toU64BE(value)
  ])
