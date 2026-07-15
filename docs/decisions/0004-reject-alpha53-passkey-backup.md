# ADR 0004: Reject Jazz alpha.53 passkey backup

Status: accepted\
Date: 2026-07-15\
Issue: #8

## Decision

Do not ship or invoke `BrowserPasskeyBackup` from `jazz-tools@2.0.0-alpha.53`. Present the identity
as a device-local auth key. State explicitly that passkey backup is blocked by security review and
that clearing site data can make the identity unrecoverable.

Do not expose 24-word phrase export/import in M1. Retain its exact semantics for a later deliberate
UX: it is a reversible encoding of the full-control auth seed and recovers identity authority, not
unsynced local data.

## Why

The exact package stores the raw 32-byte Jazz auth secret in the WebAuthn user handle and reads it
back from `AuthenticatorAssertionResponse.userHandle`. The WebAuthn specification defines that field
as an account identifier and warns that authenticators may reveal it without prior user
verification. Ceremony flags and credProtect do not establish a general confidentiality contract for
the field.

The API also cannot prove that a created credential is synced or manage/revoke its credentials.
Physical-device success would therefore not establish the security or recovery promise lofi needs.

## Replacement acceptance

A replacement must:

- keep the auth seed out of WebAuthn identifiers and non-confidential metadata;
- wrap/encrypt the seed using an authenticator-derived or otherwise reviewed secret;
- bind a stable RP ID and verify the complete ceremony/server record as applicable;
- distinguish local credential creation from ecosystem backup state;
- support duplicate prevention, inventory, replacement, and recovery failure UX;
- retain real iOS and Android browser/installed-app evidence before graduation.
