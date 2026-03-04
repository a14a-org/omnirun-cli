This directory stores Changesets release notes used for versioning and npm publishing.

- Add a changeset for every user-visible change: `npm run changeset`
- Release workflow will open/update a version PR on `main`
- Merging the version PR publishes to npm using `NPM_TOKEN`
