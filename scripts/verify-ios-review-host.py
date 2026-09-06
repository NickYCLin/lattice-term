#!/usr/bin/env python3
"""驗證隔離審核主機；所有連線資料來自私密環境，不輸出主機或憑證。"""

import argparse
import base64
import hmac
import json
import logging
import os
import secrets
import socket
import sys
import time
import uuid
from pathlib import Path

import paramiko


def verify(config, unix_socket=None):
    results = []

    def connect(password):
        if unix_socket:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(15)
            sock.connect(unix_socket)
        else:
            sock = socket.create_connection((config['host'], int(config['port'])), timeout=15)
        transport = paramiko.Transport(sock)
        try:
            transport.start_client(timeout=15)
            expected = base64.b64decode(config['host_key'].split()[1], validate=True)
            if not hmac.compare_digest(transport.get_remote_server_key().asbytes(), expected):
                raise ValueError('Host key mismatch')
            transport.auth_password(config['username'], password)
            return transport
        except BaseException:
            transport.close()
            raise

    def passed(name):
        results.append(name)
        print(json.dumps({'check': name, 'result': 'passed'}), flush=True)

    try:
        unexpected = connect(secrets.token_urlsafe(40))
    except paramiko.AuthenticationException:
        passed('reject_wrong_password')
    else:
        unexpected.close()
        raise AssertionError('Wrong password accepted')

    with connect(config['password']) as transport:
        passed('pinned_host_key_and_password_login')
        with transport.open_session(timeout=15) as channel:
            channel.settimeout(15)
            channel.exec_command("test \"$(id -u)\" = 1000 && cd /home/reviewer && pwd && printf 'LatticeTerm review\\n'")
            output = channel.makefile('rb').read(4096)
            assert channel.recv_exit_status() == 0
            assert output == b'/home/reviewer\nLatticeTerm review\n'
        passed('ssh_command_execution')

        with transport.open_session(timeout=15) as channel:
            channel.settimeout(15)
            channel.get_pty(term='xterm-256color', width=80, height=24)
            channel.invoke_shell()
            channel.resize_pty(width=100, height=32)
            channel.sendall("stty size; printf '\\nLATTICETERM_PTY_OK\\n'\n")
            output = b''
            deadline = time.monotonic() + 15
            while b'\r\nLATTICETERM_PTY_OK\r\n' not in output or b'32 100\r\n' not in output:
                assert time.monotonic() < deadline
                block = channel.recv(4096)
                assert block
                output += block
                assert len(output) < 65536
        passed('interactive_terminal_and_resize')

        with paramiko.SFTPClient.from_transport(transport) as sftp:
            sftp.get_channel().settimeout(15)
            assert 'review-data' in sftp.listdir('.')
            with sftp.file('review-data/traditional-chinese.txt', 'rb') as remote:
                assert '繁體中文' in remote.read(4096).decode('utf-8')
            path = 'review-data/uploads/verification-' + uuid.uuid4().hex + '.txt'
            payload = ('LatticeTerm SSH/SFTP 驗證\n' + secrets.token_hex(256)).encode('utf-8')
            created = False
            try:
                with sftp.file(path, 'wx') as remote:
                    created = True
                    remote.write(payload)
                with sftp.file(path, 'rb') as remote:
                    assert remote.read(len(payload) + 1) == payload
            finally:
                if created:
                    sftp.remove(path)
        passed('sftp_list_unicode_download_upload_and_cleanup')

        with transport.open_session(timeout=15) as channel:
            channel.settimeout(15)
            channel.exec_command(
                'test "$(ls /sys/class/net)" = lo && '
                'test ! -r /etc/shadow && test ! -e /Users && '
                'test "$(cat /sys/fs/cgroup/review/pids.max)" = 128 && '
                'test "$(cat /sys/fs/cgroup/review/memory.max)" = 268435456 && '
                'grep -q /review /proc/self/cgroup'
            )
            assert channel.recv_exit_status() == 0
        passed('no_network_adapter_no_mac_files_and_resource_limits')

        try:
            forwarded = transport.open_channel('direct-tcpip', ('127.0.0.1', 2222), ('127.0.0.1', 0), timeout=15)
        except paramiko.ChannelException:
            passed('ssh_forwarding_disabled')
        else:
            forwarded.close()
            raise AssertionError('SSH forwarding unexpectedly enabled')

    return {'result': 'passed', 'checks': results, 'boundary': 'unix_socket' if unix_socket else 'external_tcp', 'ios_device_tested': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, help='本機私密 JSON；CI 改用 IOS_REVIEW_HOST_CHECK secret')
    parser.add_argument('--unix-socket', help='只供本機 VM 驗證，不代表外網可達')
    args = parser.parse_args()
    logging.getLogger('paramiko').addHandler(logging.NullHandler())
    logging.getLogger('paramiko').setLevel(logging.CRITICAL)
    try:
        config = json.loads(args.config.read_text() if args.config else os.environ['IOS_REVIEW_HOST_CHECK'])
        result = verify(config, args.unix_socket)
    except Exception as error:
        # Exceptions may contain addresses or account data. Emit only their type.
        print(json.dumps({'result': 'failed', 'error_type': type(error).__name__, 'ios_device_tested': False}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
