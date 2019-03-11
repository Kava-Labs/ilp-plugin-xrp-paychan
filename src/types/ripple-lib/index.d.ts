import { FormattedPaymentChannel as PaymentChannel } from 'ripple-lib/dist/npm/ledger/parse/payment-channel'

declare module 'ripple-lib' {
  export interface FormattedPaymentChannel extends PaymentChannel {
    /** Total amount of XRP funded in this channel */
    amount: string
    /** Total amount of XRP delivered by this channel */
    balance: string
  }
}
