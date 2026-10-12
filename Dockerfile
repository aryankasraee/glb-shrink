FROM node:22.23.3-slim

WORKDIR /app
COPY package.json package-lock.json ./
# three is only used by `glb-shrink compare`, which the service doesn't need.
RUN npm ci --omit=dev && rm -rf node_modules/three && npm cache clean --force
COPY bin ./bin
COPY src ./src

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "bin/glb-shrink.js"]
CMD ["serve"]
