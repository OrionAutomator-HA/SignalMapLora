# SignalMap LoRa

Web app that ranks antenna sites inside a drawn map area using terrain line-of-sight and LoRa-style coverage.

## Run on a server with Docker Compose

The repo includes [`docker-compose.yml`](docker-compose.yml). Clone it, then start the stack:

```bash
git clone https://github.com/OrionAutomator-HA/SignalMapLora.git
cd SignalMapLora
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:5174`, or point Nginx Proxy Manager at that host and port.

```bash
docker compose logs -f
docker compose down
```

The container needs outbound HTTPS so it can fetch terrain tiles.

## Local development

```bash
npm install
npm run dev
```

On PowerShell, if `npm` is blocked, use `npm.cmd install` and `npm.cmd run dev`. Then open http://localhost:5173/
