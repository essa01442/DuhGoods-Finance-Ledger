import tape from 'tape';
import fs from 'fs';
import path from 'path';

tape('Bidi Directional Isolation Suite', (t) => {
  t.test('src/components/Bdi.vue defines LTR directional isolation', (st) => {
    const bdiPath = path.resolve(__dirname, '../src/components/Bdi.vue');
    st.ok(fs.existsSync(bdiPath), 'src/components/Bdi.vue exists');
    const content = fs.readFileSync(bdiPath, 'utf8');
    st.ok(content.includes('dir="ltr"'), 'Bdi specifies dir="ltr"');
    st.ok(
      content.includes('unicode-bidi: isolate'),
      'Bdi uses unicode-bidi: isolate'
    );
    st.end();
  });

  t.test(
    'Production call site 1: WindowsTitleBar uses Bdi for database path',
    (st) => {
      const filePath = path.resolve(
        __dirname,
        '../src/components/WindowsTitleBar.vue'
      );
      st.ok(fs.existsSync(filePath), 'WindowsTitleBar.vue exists');
      const content = fs.readFileSync(filePath, 'utf8');
      st.ok(content.includes("import Bdi from './Bdi.vue';"), 'Imports Bdi');
      st.ok(content.includes('<Bdi :value="dbPath" />'), 'Uses Bdi for dbPath');
      st.end();
    }
  );

  t.test(
    'Production call site 2: DatabaseSelector uses Bdi for truncated dbPath',
    (st) => {
      const filePath = path.resolve(
        __dirname,
        '../src/pages/DatabaseSelector.vue'
      );
      st.ok(fs.existsSync(filePath), 'DatabaseSelector.vue exists');
      const content = fs.readFileSync(filePath, 'utf8');
      st.ok(
        content.includes("import Bdi from 'src/components/Bdi.vue';"),
        'Imports Bdi'
      );
      st.ok(
        content.includes('<Bdi :value="truncate(file.dbPath)" />'),
        'Uses Bdi for file.dbPath'
      );
      st.end();
    }
  );

  t.test(
    'Production call site 3: QuickView uses Bdi for record name/ID',
    (st) => {
      const filePath = path.resolve(
        __dirname,
        '../src/components/QuickView.vue'
      );
      st.ok(fs.existsSync(filePath), 'QuickView.vue exists');
      const content = fs.readFileSync(filePath, 'utf8');
      st.ok(content.includes("import Bdi from './Bdi.vue';"), 'Imports Bdi');
      st.ok(content.includes('<Bdi :value="name" />'), 'Uses Bdi for name');
      st.end();
    }
  );

  t.test('Generic FormHeader remains natural RTL without forced LTR', (st) => {
    const filePath = path.resolve(
      __dirname,
      '../src/components/FormHeader.vue'
    );
    st.ok(fs.existsSync(filePath), 'FormHeader.vue exists');
    const content = fs.readFileSync(filePath, 'utf8');
    st.notOk(
      content.includes('dir="ltr"'),
      'FormHeader does not force LTR direction'
    );
    st.end();
  });
});
