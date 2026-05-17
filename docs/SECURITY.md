# Security Notes

## Standard Wallet security boundary

The Standard Wallet trust boundary is local key ownership:

- key generation happens in the browser;
- encrypted keyfiles are handled locally by the user;
- unlock happens in the browser;
- Standard Wallet signing happens in the browser;
- the server stores public wallet descriptors and broadcasts signed artifacts.

## Server authority for Standard Wallets

The server can provide transaction build data and broadcast signed transactions. The WTS v1 source-visible reference does not show the server holding Standard Wallet mnemonic or private key fields.

## User responsibilities

Standard Wallet users must protect their local keyfile and passphrase. Loss of the keyfile or passphrase may prevent wallet recovery. Anyone with both the encrypted keyfile and passphrase may be able to unlock the wallet.

## Explicit exclusions

Broker-Custody Wallets are not Standard Wallet self-custody. They use a different custody model and are outside WTS v1.

Direct swap and Open swap internals are outside WTS v1 and should not be treated as proven by this release.

This repository does not include production secrets, customer data, server deployment configuration, Compliance Node custody internals, or operational infrastructure.
