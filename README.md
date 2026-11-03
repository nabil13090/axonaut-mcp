# axonaut-mcp

Serveur MCP distant (Streamable HTTP, mode sans session) pour l'API Axonaut v2, utilisable comme **connecteur personnalisé** dans claude.ai.

- Node.js 20+ / TypeScript, `@modelcontextprotocol/sdk`, Express (écoute sur `127.0.0.1:3333`, nginx devant)
- Endpoint : `POST /mcp/<MCP_SECRET>` — toute autre route → 404
- Outils : `axonaut_me`, `axonaut_list`, `axonaut_get`, `axonaut_search_company`, `axonaut_request`, `axonaut_api_doc`
- `READ_ONLY=true` (défaut) : tout sauf GET est refusé, avant même l'appel à Axonaut
- Rate limit 60 req/min/IP, logs sans clé API ni secret (le chemin n'est jamais journalisé)

## Variables d'environnement (`.env`, jamais commité)

| Variable | Rôle |
|---|---|
| `AXONAUT_API_KEY` | Clé API Axonaut |
| `MCP_SECRET` | Jeton aléatoire 48+ caractères (`openssl rand -hex 32` = 64 car.) |
| `READ_ONLY` | `true` (défaut) : lecture seule |
| `PORT` | 3333 |
| `RATE_LIMIT_PER_MIN` | optionnel, défaut 60 |

## Test local

```bash
npm ci
npm test        # compile + test de fumée complet contre un faux Axonaut (aucune clé réelle requise)
cp .env.example .env && nano .env
npm run dev     # lance sur 127.0.0.1:3333
```

## Déploiement sur le VPS Hostinger (Ubuntu)

Remplacez `mcp.VOTRE-DOMAINE.fr` par votre sous-domaine. Connectez-vous en SSH (`ssh root@IP_DU_VPS`).

### 1. Prérequis : Node 20, git, nginx, certbot, pm2

```bash
apt update && apt upgrade -y
apt install -y curl git nginx ufw certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v            # v20.x
npm install -g pm2

# Pare-feu (adaptez si vous en avez déjà un)
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

### 2. Installer le projet dans /opt/axonaut-mcp

Depuis votre poste (copie du dossier, sans node_modules/dist) :

```bash
# sur votre machine
scp axonaut-mcp.zip root@IP_DU_VPS:/tmp/
```

Sur le VPS :

```bash
apt install -y unzip
mkdir -p /opt/axonaut-mcp && cd /opt/axonaut-mcp
unzip -o /tmp/axonaut-mcp.zip -d /tmp/ && cp -a /tmp/axonaut-mcp/. /opt/axonaut-mcp/
# (ou : git clone <votre-depot> /opt/axonaut-mcp)

npm ci
npm run build

cp .env.example .env
nano .env          # renseigner AXONAUT_API_KEY et MCP_SECRET
chmod 600 .env
```

Générer le secret :

```bash
openssl rand -hex 32     # 64 caractères → à coller dans MCP_SECRET
```

### 3. Lancer avec pm2 (redémarrage auto au boot)

```bash
cd /opt/axonaut-mcp
pm2 start ecosystem.config.cjs
pm2 startup systemd      # exécutez la commande qu'il affiche
pm2 save
pm2 status
pm2 logs axonaut-mcp --lines 20
```

Test local sur le VPS :

```bash
curl -s -X POST http://127.0.0.1:3333/mcp/$(grep ^MCP_SECRET .env | cut -d= -f2) \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 4. DNS (hPanel Hostinger)

hPanel → Domaines → votre domaine → **DNS / Serveurs de noms** → ajouter un enregistrement :

- Type : `A`
- Nom : `mcp`
- Pointe vers : l'IP du VPS
- TTL : 300

Vérifier la propagation : `dig +short mcp.VOTRE-DOMAINE.fr`

### 5. nginx en reverse proxy

```bash
cat > /etc/nginx/sites-available/axonaut-mcp <<'EOF'
server {
    listen 80;
    server_name mcp.VOTRE-DOMAINE.fr;

    # Le secret est dans l'URL : on ne journalise pas les requêtes
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Streaming (SSE / Streamable HTTP)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
EOF
ln -s /etc/nginx/sites-available/axonaut-mcp /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 6. SSL avec certbot

```bash
certbot --nginx -d mcp.VOTRE-DOMAINE.fr --redirect -m votre@email.fr --agree-tos -n
systemctl status certbot.timer     # renouvellement automatique
```

certbot réécrit le bloc `server` en HTTPS ; vérifiez que `access_log off;` y est toujours (`nginx -T | grep -n access_log`).

### 7. Tests

```bash
SECRET=$(grep ^MCP_SECRET /opt/axonaut-mcp/.env | cut -d= -f2)

# Doit répondre avec la liste des 6 outils
curl -s -X POST https://mcp.VOTRE-DOMAINE.fr/mcp/$SECRET \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Doit répondre 404
curl -i https://mcp.VOTRE-DOMAINE.fr/mcp/mauvais-secret
```

MCP Inspector (depuis votre poste) :

```bash
npx @modelcontextprotocol/inspector
```

Transport : **Streamable HTTP**, URL : `https://mcp.VOTRE-DOMAINE.fr/mcp/<MCP_SECRET>`, puis *Connect* → *Tools* → *axonaut_me*.

### 8. Ajout dans claude.ai

Paramètres → Connecteurs → **Ajouter un connecteur personnalisé** :

- URL : `https://mcp.VOTRE-DOMAINE.fr/mcp/<MCP_SECRET>`
- Laissez les champs OAuth vides.

Pour plusieurs personnes : donnez-leur la même URL (le secret fait office de clé d'accès). Pour révoquer l'accès : changez `MCP_SECRET` dans `.env`, puis `pm2 restart axonaut-mcp --update-env`.

## Mise à jour

```bash
cd /opt/axonaut-mcp && git pull   # ou recopier les fichiers
npm ci && npm run build && pm2 restart axonaut-mcp
```

## Notes

- Mode sans session : chaque requête est indépendante (adapté à claude.ai). `GET /mcp/<secret>` renvoie 405.
- `axonaut_search_company` essaie d'abord `GET /companies/search?name=` ; si l'API ne le gère pas, repli sur un filtrage local des 500 sociétés les plus récentes (indiqué dans la réponse).
- Le nombre total de pages sur un 403 « Too many results » n'est indiqué que si l'API le mentionne dans son message ; sinon la réponse l'indique.
- Les filtres listés par `axonaut_api_doc` sont non exhaustifs : à confronter à la documentation Axonaut.
