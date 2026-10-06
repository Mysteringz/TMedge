import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firmwareSourcePath } from '../src/shared/firmware-upload.js';

test('folder uploads include release sources and exclude local credentials and generated output', () => {
  const paths = [
    'TMsense/platformio.ini', 'TMsense/src/main.cpp', 'TMsense/src/drivers/sensor.cc',
    'TMsense/include/tm_config.h', 'TMsense/include/node_config.h', 'TMsense/include/tm_test_ca.h',
    'TMsense/.env', 'TMsense/.pio/build/tmflash/firmware.bin', 'TMsense/.git/config',
    'TMsense/include/nested/node_config.h', 'TMsense/src/../node_config.h',
  ];
  assert.deepEqual(paths.map(firmwareSourcePath).filter((path) => path !== null), [
    'platformio.ini', 'src/main.cpp', 'src/drivers/sensor.cc', 'include/tm_config.h',
  ]);
  assert.equal(firmwareSourcePath('platformio.ini'), 'platformio.ini');
  assert.equal(firmwareSourcePath('src/main.cpp'), 'src/main.cpp');
  assert.equal(firmwareSourcePath('/src/main.cpp'), null);
  assert.equal(firmwareSourcePath('../src/main.cpp'), null);
  assert.equal(firmwareSourcePath('src/../../secret.h'), null);
});
