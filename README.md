# SignalMap LoRa

Web app that ranks antenna sites inside a drawn map area using terrain line-of-sight and LoRa-style coverage.

## Run on a server with Docker

```bash
git clone https://github.com/OrionAutomator-HA/SignalMapLora.git
cd SignalMapLora
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:8080`

Another host port:

```bash
PORT=80 docker compose up -d --build
```

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
