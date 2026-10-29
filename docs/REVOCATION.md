# Revoking a technician: next step

Not built. Today a technician code expires after one day by default and five at most, and nothing revokes it
sooner. This page sets out the problem and the plan.

## Where a sensor gets a network

| Stage | Where | Network on the sensor |
| --- | --- | --- |
| 1. `iot-workshop deploy`: install, key, certify for one customer | The manufacturer's workshop | None |
| 2. Shipping and mounting | Hospital | None |
| 3. Wi-Fi setup from Provide., over Bluetooth | Hospital | None, then the hospital Wi-Fi |
| 4. In service | Hospital | Hospital Wi-Fi |

A technician sets a sensor up on site, after mounting. Until stage 3 ends, no message reaches the sensor over a
network. The technician's phone has signal more often.

## Who must enforce it

The sensor. It receives the Wi-Fi password and decides to obey. Provide. checks a code too, but a stolen code works
from a modified app or any Bluetooth tool. A revoked technician in Bluetooth range could give a sensor a network of
their choice, or move a configured one off the hospital Wi-Fi. They never learn the hospital's password: no sensor
sends it back.

## What expiry covers today

- `issue` makes 1-day codes; the long form allows 5 days at most.
- `deploy` records the workshop's time as the sensor's clock floor. A sensor without a battery-backed clock can boot
  far in the past (Jetson 027 ran 171 days late); with the floor, it refuses any code that expired before its
  deployment.
- A code expired after deployment still works on a sensor whose clock lags, until the sensor joins Wi-Fi and syncs
  its time.

## What offline systems do

| System | Offline revocation | The manufacturer equivalent |
| --- | --- | --- |
| [Salto JustIN Mobile](https://support.saltosystems.com/space/justin/faqs/) | The phone key opens doors offline; the app revalidates it every 7 days | The phone renews short codes |
| [igloohome algoPIN](https://docs.getseam.com/latest/device-and-system-integration-guides/igloohome-locks) | Codes valid 24 h, generated without contacting the lock | Today's 1-day codes |
| [Salto SVN](https://support.saltosystems.com/space/user-guide/operator/getting-started/system-overview/) | Online readers write the deny list onto cards; cards carry it to each offline lock | Phones carry the list |
| [Hotel locks](https://homepage.cs.uiowa.edu/~tinelli/classes/181/Fall21/Notes/07-hotel-model.pdf) | A newer key's sequence number cancels older keys, with no network | A newer code moves the sensor's clock forward |
| [Polestar digital key](https://www.polestar.com/ie/support/faq/polestar-3-digital-key/) | A revoked shared key stops after one drive or 48 h | A bounded delay |
| [IETF STAR](https://datatracker.ietf.org/doc/html/draft-nir-saag-star-01) | Short auto-renewed certificates: expiry replaces revocation | Same principle |

None of them revokes an offline device at once; each bounds the delay with expiry, or with credentials that carry updates from door to door.

## Plan

1. **The phone renews short codes.** When it has signal, Provide. asks a manufacturer service for a new code, valid about
   a day, for the same holder key. Revoking a technician means the service stops renewing. Setup stays offline: the
   phone needs signal once a day, not in the hallway.
2. **Phones carry the revocation list.** Each setup hands the sensor the newest list signed by the technician
   authority. The sensor refuses an older list, so a phone cannot forge or roll one back. A revoked technician's
   phone will not deliver it; the other phones will.
3. **A newer code moves the clock.** Each code carries its signed issue time, and the sensor raises its clock floor
   to the newest one it has seen, as a hotel lock does with key sequence numbers. An old code then expires on every
   sensor a newer code has reached.
4. **Smith pushes the list** to sensors in service, once they are on the hospital Wi-Fi.
5. **A configured sensor accepts a new network** only for a few minutes after a local action, like the 5 minutes of
   the manufacturer's *WiFi Broadcast*. A code alone then cannot move it.

Items 2 and 3 change the Bluetooth protocol or the code format. Item 1 needs an online signing key, certified by
the offline technician authority, which stays at the workshop.

## Rejected: an online authorization for each setup

The phone would fetch, for each sensor, a server signature bound to the session. A revoked code would stop at once,
but every setup would need internet. That breaks the challenge's first constraint ("no internet, no cloud relay"),
and an outage or a basement with no signal would block a wing of 200 sensors.

## Open questions

- How the phone authenticates to the renewal service: the holder key is an X25519 key and cannot sign.
- Whether the manufacturer's Edge already has a channel to Smith that item 4 could reuse.
- The local action for item 5 on a sensor with no button, and how the technician sees the window open.
