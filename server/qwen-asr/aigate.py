"""Use the public AIGate API to inventory workers and save ASR images."""

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request

ROOT = 'https://waas.aigate.cc/api/openapi/'
AREAS = ('华东一区', '华东二区')


def call(path, *, query=None, body=None):
    url = ROOT + path
    if query:
        url += '?' + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + os.environ['AIGATE_ACCESS_TOKEN'],
        'Content-Type': 'application/json',
    }, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    if value['code'] != 0:
        raise RuntimeError(f'{path}: {value.get("errCode")} {value.get("msg")}')
    return value['data']


def records(path, **filters):
    page = 1
    while True:
        result = call(path, body={'current': page, 'pageSize': 20, **filters})
        yield from result['records']
        if page * 20 >= int(result['total']):
            return
        page += 1


def select(row, keys):
    return {key: row[key] for key in keys.split() if key in row}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('inventory')
    create = commands.add_parser('create')
    create.add_argument('area', choices=AREAS)
    create.add_argument('sku')
    create.add_argument('base_image_id', type=int)
    create.add_argument('name')
    create.add_argument('--base-image-type', choices=('2', '3'), required=True)
    save = commands.add_parser('save')
    save.add_argument('instance_id', type=int)
    save.add_argument('name')
    status = commands.add_parser('image')
    status.add_argument('image_id', type=int)
    args = parser.parse_args()
    if not os.environ.get('AIGATE_ACCESS_TOKEN'):
        parser.error('Set AIGATE_ACCESS_TOKEN in the existing deployment environment.')

    image_fields = 'worksId name status size areaName imageType servicePort'
    instance_fields = 'instanceId instanceName instanceStatus operationStatus areaName imageId imageType skuName'
    if args.command == 'inventory':
        value = {
            'instances': [select(row, instance_fields) for row in records('instance/page')],
            'images': [select(row, image_fields) for row in records('image/page', imageType='3')],
            'skus': {area: [select(row, 'skuName price vmSize sysDiskSize') for row in
                            call('instance/skuList', query={'areaName': area})] for area in AREAS},
        }
    elif args.command == 'create':
        existing = [row for row in records('instance/page')
                    if row.get('instanceName') == args.name and row.get('areaName') == args.area
                    and str(row.get('operationStatus')) != '4']
        if len(existing) > 1:
            raise RuntimeError('Multiple instances match this name and area.')
        instance = existing[0] if existing else call('instance/start', body={
            'areaName': args.area, 'skuName': args.sku, 'count': 1, 'imageId': args.base_image_id,
            'imageType': args.base_image_type, 'instanceName': args.name,
        })
        value = select(instance, instance_fields)
    elif args.command == 'save':
        instance = call('instance/get', query={'instanceId': args.instance_id})
        existing = [row for row in records('image/page', imageType='3')
                    if row.get('name') == args.name and row.get('areaName') == instance['areaName']
                    and str(row.get('status')) in ('1', '2')]
        if len(existing) > 1:
            raise RuntimeError('Multiple personal images match this name and area.')
        image = existing[0] if existing else call('image/save', body={
            'instanceId': args.instance_id, 'imageName': args.name,
        })
        value = select(image, image_fields)
    else:
        value = select(call('image/get', body={'imageId': args.image_id, 'imageType': '3'}), image_fields)
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as error:
        raise SystemExit(str(error)) from None
