"""Password hashing and auth tokens, on the standard library only."""

import base64
import hashlib
import hmac
import secrets

_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_DK_LEN = 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_DK_LEN,
        maxmem=64 * 1024 * 1024,
    )
    return "$".join(
        [
            "scrypt",
            str(_SCRYPT_N),
            str(_SCRYPT_R),
            str(_SCRYPT_P),
            base64.b64encode(salt).decode(),
            base64.b64encode(dk).decode(),
        ]
    )


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        scheme, n, r, p, salt_b64, dk_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(base64.b64decode(dk_b64)),
            maxmem=64 * 1024 * 1024,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, base64.b64decode(dk_b64))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
