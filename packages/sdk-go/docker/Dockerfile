# The Go SDK's checks (plan 34): the official Go image of the version asked for, with staticcheck
# pinned. Built by scripts/go.mjs, which mounts the repository and keeps the module and build caches
# in a volume. GOTOOLCHAIN=local, so a go directive above the image's Go fails instead of fetching
# another toolchain; no VCS stamping, which would run git on a worktree's checkout.
ARG GO=1.26
FROM golang:${GO}
ARG STATICCHECK=v0.8.2
RUN GOTOOLCHAIN=local GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@${STATICCHECK} \
  && rm -rf /root/.cache /go/pkg
LABEL dev.formfeed.staticcheck=${STATICCHECK}
ENV GOTOOLCHAIN=local GOFLAGS=-buildvcs=false
