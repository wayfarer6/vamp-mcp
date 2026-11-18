"""Fail-closed validation of the selected switch's read-only host probe."""
import ipaddress
from urllib.parse import urlsplit

# Fixed, read-only cmdlet query. The request never becomes a PowerShell command
# and we do not load, reinterpret, or unblock any script file.
NETWORK_QUERY = """
$ErrorActionPreference='Stop';
$switches=@(Get-VMSwitch | Select-Object Name, @{n='Type';e={[string]$_.SwitchType}});
$addresses=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource
} | Select-Object InterfaceAlias, IPAddress);
@{switches=$switches; addresses=$addresses; execution_policy=[string](Get-ExecutionPolicy)} | ConvertTo-Json -Depth 4 -Compress
""".replace('\n',' ')


def select_network(probe, switch_name, selected=None):
    if not isinstance(probe, dict) or not isinstance(probe.get('switches'), list) or not isinstance(probe.get('addresses'), list):
        raise ValueError('Invalid JSON evidence from the Hyper-V switch and address query')
    switches = [row for row in probe['switches'] if isinstance(row, dict) and row.get('Name') == switch_name]
    if len(switches) != 1:
        raise ValueError('Exactly one explicitly selected Hyper-V switch is required')
    candidates = set()
    for row in probe['addresses']:
        if not isinstance(row, dict) or row.get('InterfaceAlias') != 'vEthernet (' + switch_name + ')':
            continue
        try:
            address = usable_ipv4(row.get('IPAddress'))
        except ValueError:
            continue
        if ipaddress.IPv4Address(address).is_private:
            candidates.add(address)
    if selected is not None:
        if selected not in candidates:
            raise ValueError('Requested bootstrap host is not a usable address of the selected Hyper-V switch')
        candidates = {selected}
    if len(candidates) != 1:
        raise ValueError('The selected Hyper-V switch must have exactly one usable guest-reachable host IPv4 address; none or ambiguous addresses are refused')
    host = candidates.pop()
    policy = probe.get('execution_policy')
    if policy not in ('Restricted','AllSigned','RemoteSigned','Unrestricted','Bypass','Undefined'):
        raise ValueError('Unable to determine the effective Windows PowerShell execution policy')
    return {'switch':switch_name,'switch_type':switches[0].get('Type'),'host_ipv4':host,
            'host_ipv4_candidates':[host],'execution_policy':policy}


def require_deployment_policy(network):
    if network['execution_policy'] == 'Restricted':
        raise ValueError('Hyper-V deployment requires an approved PowerShell script, but the effective policy is Restricted. No build was started; consult your Windows administrator. VAMP does not change execution policy.')


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
