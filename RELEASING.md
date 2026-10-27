# Publishing a release

Keep dependency updates separate from a theme release. Build from the committed
lockfile using Node.js 24.19.0.

Update `theme.json`, `package.json` and both root version fields in
`package-lock.json` together, then run the local checks:

```sh
npm ci
npm test
npm run test:tooling
npm run lint
npm run build
npm run package
npm run check:package -- --archive theme.tar.gz
```

Check the final build with synthetic data, including the dense day-history
scenario, legend toggles, zoom, narrow layouts and reduced motion. Describe
any untested behavior in the release notes.

The checksum file uses the standard `sha256sum` format:

```text
<sha256>  theme.tar.gz
```

Generate it from the exact archive that passed the checks:

```sh
node --input-type=module -e "import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; writeFileSync('theme.tar.gz.sha256',createHash('sha256').update(readFileSync('theme.tar.gz')).digest('hex')+'  theme.tar.gz\n')"
```

Review and commit the source changes. Create and push a tag matching
`theme.json`, then publish the checked archive with GitHub CLI:

```sh
git tag -a v0.1.6 -m "Rhine Observation v0.1.6"
git push origin main
git push origin v0.1.6
gh release create v0.1.6 theme.tar.gz theme.tar.gz.sha256 \
  --verify-tag --title "Rhine Observation v0.1.6" --notes-file release-notes.md
```

Use `theme.tar.gz` and its checksum as release assets. GitHub's automatically
generated source archives are not installable theme packages. Keep an existing
release unchanged; publish a new version when the source or archive changes.

After publishing, download the release archive independently and verify its
SHA-256 against the file that was tested. A successful build alone does not
prove that the uploaded archive is the same file.
