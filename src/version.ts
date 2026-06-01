// Build version — comes from the git tag that triggered the release, baked
// into the image at build time via `--build-arg APP_VERSION=<tag>` →
// `ENV APP_VERSION` (Dockerfile). There is NO hand-edited constant anymore:
// release = `git tag vN && git push --tags`, and that tag becomes the value
// served by `GET /version` and stamped (`__APP_VERSION__`) into the
// server-rendered login/welcome/access-denied footers.
//
// `.git` is in `.dockerignore`, so the container can't run `git describe` —
// the tag has to arrive as a build-arg, never inferred at runtime. Falls back
// to 'dev' for local runs (`bun run dev`, tests) where no tag is baked in.
export const APP_VERSION = process.env.APP_VERSION || 'dev'
