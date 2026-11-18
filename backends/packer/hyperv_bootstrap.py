"""Fail-closed validation of the selected switch's read-only host probe."""
import ipaddress
from urllib.parse import urlsplit


def host_ipv4(network, switch_name):
    if not isinstance(network, dict) or network.get('switch') != switch_name:
        raise ValueError('Hyper-V bootstrap switch evidence does not match the selected switch')
    addresses = network.get('host_ipv4_candidates')
    if not isinstance(addresses, list) or len(addresses) != 1:
        raise ValueError('Hyper-V bootstrap requires exactly one usable host IPv4 address on the selected switch')
    host = usable_ipv4(addresses[0])
    if not ipaddress.IPv4Address(host).is_private:
        raise ValueError('Hyper-V bootstrap refuses a publicly routed host listener')
    if network.get('host_ipv4') != host:
        raise ValueError('Hyper-V bootstrap host evidence is inconsistent')
    return host


def usable_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except (ValueError, TypeError, ipaddress.AddressValueError):
        raise ValueError('A usable guest-reachable host IPv4 address is required') from None
    if address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved:
        raise ValueError('A usable guest-reachable host IPv4 address is required')
    return str(address)


def bootstrap_origin(base):
    url = urlsplit(base)
    if url.scheme != 'http' or url.username or url.password or url.path or url.query or url.fragment or url.port != 8421:
        raise ValueError('Bootstrap origin must be an explicit host IPv4 on HTTP port 8421')
    host = usable_ipv4(url.hostname)
    if base != 'http://' + host + ':8421':
        raise ValueError('Bootstrap origin is not canonical')
    return host


def requested_host(request, env):
    value=request.get('bootstrap_host')
    if value is None:
        value=env.get('VAMP_PACKER_BOOTSTRAP_HOST')
    if value is None:
        return None
    host=usable_ipv4(value)
    if not ipaddress.IPv4Address(host).is_private:
        raise ValueError('Hyper-V bootstrap refuses a publicly routed host listener')
    return host
