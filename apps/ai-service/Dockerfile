# Recall Tracker — Recall Advisor AI service (internal only).
#
# Build from the REPO ROOT:
#   docker build -f apps/ai-service/Dockerfile -t recall-ai-service .
#
# No build step: runs TypeScript directly under Node's native type stripping.
#
# Owns the recall.recallAdvisor flag gate, so it needs FM_KEY at runtime. With
# no key the SDK falls back to code defaults, which for that flag means false —
# chat returns 403. That is the monolith's behaviour and is intentional.

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# --chown on every COPY is load bearing. Docker preserves source file modes, and
# a checkout whose files are mode 600 lands in the image owned by root and
# unreadable by USER node — the service then dies at startup with EACCES on the
# first source file it imports. git tracks only the executable bit, so a fresh CI
# clone is 644 and never reproduces it; this is a local-only failure that CI
# cannot catch. Setting ownership makes the image independent of the checkout.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node apps/ai-service/package.json ./apps/ai-service/
RUN npm ci --workspace @recall/ai-service --include-workspace-root --omit=dev

COPY --chown=node:node packages/shared ./packages/shared
COPY --chown=node:node apps/ai-service ./apps/ai-service

USER node

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/ai-service/src/server.ts"]
