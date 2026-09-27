# Contributing

Issues and pull requests are welcome here.

This repository is a mirror. The CLI is developed alongside the Fieldwork Ledger service,
where every command is also tested against a running server; those tests need the server and
are not part of this repository. An accepted change is applied there and arrives back here
with the next sync, crediting you. The tests here -- `npm test` -- cover what runs without
a server: the HTTP client, credentials, selection, the changelog and every command's help.

```sh
npm install
npm run build
npm test
```

Security issues: please report them privately, through this repository's Security tab
("Report a vulnerability"), rather than in a public issue.
