FROM node:20-alpine

WORKDIR /app

# Copy server script
COPY server.js .

# Create persistent data volume directory
VOLUME /app/data

EXPOSE 3000

ENV PORT=3000
ENV BIND_HOST=0.0.0.0
ENV DATA_DIR=/app/data

CMD ["node", "server.js"]
