FROM node:20-bullseye-slim

WORKDIR /app

COPY package*.json ./

RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN npm install

COPY . .

RUN npm run build

RUN npm prune --production

EXPOSE 8080

CMD ["node", "--max-old-space-size=128", "dist/index.js"]
