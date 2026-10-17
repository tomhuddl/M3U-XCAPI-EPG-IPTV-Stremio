# Use a supported Node.js LTS image.
FROM node:22-alpine

WORKDIR /app

# Install exactly the versions recorded in package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application files without making the runtime process root.
COPY --chown=node:node . .

EXPOSE 7000

USER node

CMD ["npm", "start"]
