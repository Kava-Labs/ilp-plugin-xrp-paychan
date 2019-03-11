# Interledger XRP Payment Channel Plugin

[![NPM Package](https://img.shields.io/npm/v/@kava-labs/ilp-plugin-xrp-paychan.svg?style=flat-square&logo=npm)](https://npmjs.org/package/@kava-labs/ilp-plugin-xrp-paychan)
[![CircleCI](https://img.shields.io/circleci/project/github/Kava-Labs/ilp-plugin-xrp-paychan/master.svg?style=flat-square&logo=circleci)](https://circleci.com/gh/kava-labs/ilp-plugin-xrp-paychan)
[![Codecov](https://img.shields.io/codecov/c/github/kava-labs/ilp-plugin-xrp-paychan.svg)](https://codecov.io/gh/kava-labs/ilp-plugin-xrp-paychan)
[![Prettier](https://img.shields.io/badge/code_style-prettier-brightgreen.svg?style=flat-square)](https://prettier.io/)
[![License](https://img.shields.io/npm/l/@kava-labs/ilp-plugin-xrp-paychan.svg?style=flat-square)](https://github.com/Kava-Labs/ilp-plugin-xrp-paychan/blob/master/LICENSE)

🚨 **Expect breaking changes while this plugin is in beta.**

## Install

```bash
npm i @kava-labs/ilp-plugin-xrp-paychan
```

## API

Here are the available options to pass to the plugin. Additional configuration options are also inherited from [ilp-plugin-btp](https://github.com/interledgerjs/ilp-plugin-btp) if the plugin is a client, and [ilp-plugin-mini-accounts](https://github.com/interledgerjs/ilp-plugin-mini-accounts) if the plugin is a server.

This plugin uses an asset scale of 6 and units of drops.

#### `xrpSecret`

- **Required**
- Type: `string`
- Secret of the XRP account used to send and receive, corresponding to the XRP address shared with peers

#### `xrpServer`

- Type: `string`
- Default: `"wss://s1.ripple.com"`
- URI for rippled websocket port to connect to

#### `role`

- Type:
  - `"client"` to connect to a single peer or server that is explicity specified
  - `"server"` to enable multiple clients to openly connect to the plugin
- Default: `"client"`

### Settlement

Clients do not automatically open channels, nor settle automatically. Channels must be funded or closed through the internal API of the plugin. Sending payment channel claims can be triggered by invoking `sendMoney` on the plugin, and the money handler is called upon receipt of incoming payment channel claims (set using `registerMoneyHandler`).

Servers _do_ automatically open channels. If a client has opened a channel with a value above the configurable `minIncomingChannelAmount`, the server will automatically open a channel back to the client with a value of `outgoingChannelAmount`. When the channel is half empty, the server will also automatically top up the value of the channel to the `outgoingChannelAmount`.

The balance configuration has been simplified for servers. Clients must prefund before sending any packets through a server, and if a client fulfills packets sent to them through a server, the server will automatically settle such that they owe 0 to the client. This configuration was chosen as a default due to it's security and protection against deadlocks.

### Closing Channels

Both clients and servers operate a channel watcher to automatically close a disputed channel if it's profitable to do so, and both will automatically claim channels if the other peer requests one to be closed.

### Transaction Fees

In the current version of this plugin, there is no accounting for transaction fees on servers. Since clients must manually open & close channels, they do have the ability to authorize transaction fees before sending them to the chain.

### Future Work

The current model introduces problems with locking up excessive liquidity for servers, and doesn't provide sufficient denial of service protections against transaction fees. Ultimately, clients will likely have to purchase incoming capacity (possibly by amount and/or time) through prefunding the server, and pay for the server's transaction fees to open and close a channel back to them. However, this may require a more complex negotiation and fee logic that is nontrivial to implement.

The ILP connector/plugin architecture is likely going to be refactored in the near future, which should simplify the external interface, enable multi-process plugins, and eliminate some of the internal boilerplate code.

#### `maxPacketAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum amount in _drops of XRP_ above which an incoming packet should be rejected

#### `outgoingChannelAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `5000000` drops, or 5 XRP
- Amount in _drops of XRP_ to use as a default to fund an outgoing channel up to
- Note: this is primarily relevant to servers, since clients that don't automatically open channels may manually specify the amount

#### `minIncomingChannelAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity` drops (channels will never automatically be opened)
- Value in _drops of XRP_ that a peer's incoming channel must exceed if an outgoing channel to the peer should be automatically opened

#### `channelWatcherInterval`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default `60000` ms, or 1 minute
- Number of milliseconds between each run of the channel watcher, which checks if the peer started a dispute and if so, claims the channel if it's profitable

#### `outgoingDisputePeriod`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `518,400` seconds, or 6 days
- Number of seconds for dispute/expiry period used to create outgoing channels

While the channel is open, the sender may begin the dispute period. If the receiver does not claim the channel before the specified number of blocks elapses and the settling period ends, all the funds can go back to the sender. Settling a channel can be useful if the receiver is unresponsive or excessive collateral is locked up.

#### `minIncomingDisputePeriod`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `259,200` seconds, or 3 days
- Minimum number of seconds for dispute/expiry period to accept a new incoming channel

In case the sender starts settling, the receiver may want to allot themselves enough time to claim the channel. Incoming claims from channels with dispute periods below this floor will be rejected outright.
