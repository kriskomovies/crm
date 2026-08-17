# Two stages so the runtime image carries no compiler and no dev dependencies.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
# Generate before compiling: the Prisma client is a build input, not an artefact.
RUN npx prisma generate
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Alpine carries no zone database, and Node without one answers every question
# about local time in UTC -- silently, with no warning and no error. TZ in the
# compose file would have looked set and done nothing, which is a worse failure
# than leaving it unset: common/day.ts counts the daily cap from local midnight,
# so the caps would keep resetting at UTC midnight while the configuration said
# otherwise. ~3 MB, and the whole point of the setting.
RUN apk add --no-cache tzdata
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations run at start rather than in the image so a rollback of the image
# does not leave the schema ahead of the code.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
