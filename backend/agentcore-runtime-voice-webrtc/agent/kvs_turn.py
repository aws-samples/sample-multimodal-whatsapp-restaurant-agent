"""KVS managed TURN credential fetch for the WhatsApp Call Runtime (Task 15).

KVS is used here ONLY as a source of TURN credentials (GetIceServerConfig), not
as a signaling channel and not as an inline media hop. Flow (per the AWS KVS
WebRTC developer guide):

  1. describe / create a SINGLE_MASTER signaling channel,
  2. get_signaling_channel_endpoint(Protocols=[HTTPS], Role=MASTER),
  3. kinesis-video-signaling get_ice_server_config(Service=TURN) -> iceServers.

This helper is promoted into the Call Runtime in Task 15 (agent/kvs_turn.py);
the spike keeps a local copy so it runs standalone. boto3 is imported lazily so
the pure SDP analysis + its tests need no AWS SDK.

NOTE: this is the Call Runtime copy. The spike (Task 14) keeps its own.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

DEFAULT_REGION = "us-east-1"


def ensure_signaling_channel(channel_name: str, region: str = DEFAULT_REGION, kvs: Any = None) -> str:
    """Return the ARN of a SINGLE_MASTER signaling channel, creating it if absent.

    The channel exists only so KVS will mint TURN credentials for it; no media
    or signaling actually flows over the channel in this design."""
    import boto3  # lazy

    kvs = kvs or boto3.client("kinesisvideo", region_name=region)
    try:
        resp = kvs.describe_signaling_channel(ChannelName=channel_name)
        return resp["ChannelInfo"]["ChannelARN"]
    except kvs.exceptions.ResourceNotFoundException:
        kvs.create_signaling_channel(
            ChannelName=channel_name, ChannelType="SINGLE_MASTER"
        )
        resp = kvs.describe_signaling_channel(ChannelName=channel_name)
        return resp["ChannelInfo"]["ChannelARN"]


def get_ice_servers(
    channel_name: str,
    region: str = DEFAULT_REGION,
    kvs: Any = None,
    signaling: Any = None,
) -> list[dict]:
    """Return the iceServers list (TURN relay URLs + short-lived credentials).

    Each entry is ``{"urls": [...], "username": ..., "credential": ...}``,
    directly usable to build aiortc RTCIceServer objects. Raises on failure -
    the spike runner surfaces the error (there is no graceful degrade for a
    spike whose whole point is to exercise the TURN path)."""
    import boto3  # lazy

    kvs = kvs or boto3.client("kinesisvideo", region_name=region)
    channel_arn = ensure_signaling_channel(channel_name, region=region, kvs=kvs)

    ep = kvs.get_signaling_channel_endpoint(
        ChannelARN=channel_arn,
        SingleMasterChannelEndpointConfiguration={
            "Protocols": ["HTTPS"],
            "Role": "MASTER",
        },
    )
    https_endpoint = next(
        e["ResourceEndpoint"] for e in ep["ResourceEndpointList"] if e["Protocol"] == "HTTPS"
    )

    signaling = signaling or boto3.client(
        "kinesis-video-signaling", endpoint_url=https_endpoint, region_name=region
    )
    cfg = signaling.get_ice_server_config(ChannelARN=channel_arn, Service="TURN")

    ice_servers: list[dict] = []
    for s in cfg.get("IceServerList", []):
        ice_servers.append(
            {
                "urls": s.get("Uris", []),
                "username": s.get("Username"),
                "credential": s.get("Password"),
                "ttl": s.get("Ttl"),
            }
        )
    logger.info("fetched %d TURN ice server entries for channel %s", len(ice_servers), channel_name)
    return ice_servers


def channel_name_from_env(default: Optional[str] = None) -> str:
    """Spike convenience: the KVS channel name from KVS_CHANNEL_NAME / default."""
    return os.environ.get("KVS_CHANNEL_NAME") or (default or "wa-voice-spike")
