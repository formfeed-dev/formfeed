# The PHP SDK's checks (plan 34): the official PHP image of the version asked for, with Composer and
# what Composer needs to unpack packages. Built by scripts/php.mjs, which mounts the repository.
ARG PHP=8.3
FROM composer:2 AS composer
FROM php:${PHP}-cli
COPY --from=composer /usr/bin/composer /usr/bin/composer
RUN apt-get update \
  && apt-get install -y --no-install-recommends git unzip \
  && rm -rf /var/lib/apt/lists/*
ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1
