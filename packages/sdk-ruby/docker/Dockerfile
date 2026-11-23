# The Ruby SDK's checks (plan 34): the official Ruby image of the version asked for, which brings
# Bundler and the compilers the development gems' native extensions need. Built by scripts/ruby.mjs,
# which mounts the repository at /repo and the gems in the volume formfeed-gem-cache at /gems.
ARG RUBY=3.3
FROM ruby:${RUBY}
# Bundler keeps the gems under /gems/bundle/ruby/<ABI>, so each Ruby version builds its own native
# extensions in the one volume
ENV BUNDLE_PATH=/gems/bundle \
    BUNDLE_SILENCE_ROOT_WARNING=1 \
    BUNDLE_JOBS=4
