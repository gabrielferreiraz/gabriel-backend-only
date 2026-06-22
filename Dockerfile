FROM node:18-bullseye-slim

# Instalar dependências necessárias para o Chromium / Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Instala todas as dependências (incluindo devDependencies para compilar)
RUN npm install

COPY . .

# Compila TypeScript → JavaScript em /app/dist
RUN npm run build

# Remove devDependencies após o build — ts-node, typescript e @types/* saem da memória
RUN npm prune --production

EXPOSE 3000

# Roda o JS compilado com node puro — sem overhead do compilador TypeScript (~1.8 GB → ~200-300 MB)
CMD ["node", "--max-old-space-size=256", "dist/index.js"]
