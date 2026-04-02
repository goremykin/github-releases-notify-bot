# Github releases notify bot
[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=CJ9JG8XQEZBRC&source=url)

![preview](https://user-images.githubusercontent.com/4976306/30619440-156248a2-9da8-11e7-9bea-202664b8f329.png)

The bot allows you to receive notifications in a telegram if a new release (or a new tag appears in the repository) of your favorite software is available in GitHub.

Bot available in Telegram: [@ReleaseNotifier_Bot](https://telegram.me/ReleaseNotifier_Bot)

## Commands
```
/actions - actions menu
/about - info about bot
```

## Running with Docker

Copy `config.example.json` to `config.json` and fill in your tokens, then:

```yaml
services:
  notify-bot:
    image: ghcr.io/goremykin/github-releases-notify-bot:latest
    volumes:
      - ./config.json:/app/config.json:ro
      - ./data:/app/data
    user: "1000:1000"
    restart: unless-stopped
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    deploy:
      resources:
        limits:
          memory: 256M
```
