#!/usr/bin/env sh
set -eu
podman-compose -f ./infra/dev/podman-compose.yml exec -T db psql -U postgres -c "drop database if exists vibes; create database vibes;"
