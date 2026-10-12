FROM node:22-alpine
# LibreOffice converts uploaded DOCX/PPTX/... to PDF for the draw-on-documents feature
RUN apk add --no-cache libreoffice-writer libreoffice-impress ttf-dejavu ttf-liberation
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
