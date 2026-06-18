CREATE TABLE themes (
    id INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    etf_symbol TEXT NOT NULL COLLATE NOCASE,
    description TEXT
);

CREATE INDEX themes_etf_symbol
    ON themes (etf_symbol);

CREATE TABLE theme_stocks (
    theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL COLLATE NOCASE,
    source TEXT NOT NULL CHECK (source IN ('manual', 'manual_ai', 'automatic_ai')),
    reasoning TEXT,
    model TEXT,
    assigned_at DATETIME NOT NULL,
    PRIMARY KEY (theme_id, symbol)
);

CREATE INDEX theme_stocks_symbol
    ON theme_stocks (symbol);

INSERT INTO themes (name, etf_symbol, description)
VALUES
    ('Semiconductors', 'SOXX', 'Chip designers and equipment; excludes software'),
    ('Software', 'IGV', 'Application and SaaS software; excludes infrastructure and security'),
    ('Cybersecurity', 'CIBR', 'Dedicated security vendors only'),
    ('Payments and Fintech', 'IPAY', 'Payments processors and digital finance'),
    ('Blockchain', 'BKCH', 'Crypto miners and exchanges; no payments overlap'),
    ('AI and Data', 'AIQ', 'AI compute and enablers; distinct from pure software'),
    ('Data Centers', 'SRVR', 'Data center REITs and digital infrastructure'),
    ('Quantum Computing', 'QTUM', 'Quantum computing and enabling technologies'),
    ('IoT', 'SNSR', 'Connected devices and sensors; excludes pure software'),
    ('Telecom', 'IYZ', 'Carriers and tower companies; excludes media'),
    ('Social Media', 'SOCL', 'Social platforms; excludes carriers and traditional media'),
    ('EVs and Mobility', 'DRIV', 'Electric vehicles and mobility; broader than EV OEMs only'),
    ('Homebuilders', 'ITB', 'Residential builders and building products'),
    ('Retail', 'XRT', 'Broadline and specialty retail; excludes grocery and e-commerce'),
    ('Travel', 'JETS', 'Airlines and lodging'),
    ('Gaming and Gambling', 'BETZ', 'Gambling and gaming exposure; broader than casinos alone'),
    ('Video Games', 'HERO', 'Game publishers and esports; no casinos'),
    ('Food and Beverage', 'PBJ', 'Packaged food and beverages; excludes restaurants and retail'),
    ('Grocery', 'FXG', 'Grocery chains and staple retailers only'),
    ('Biotech', 'ARKG', 'Gene editing and biotech R and D; no devices or pharma'),
    ('Pharma', 'IHE', 'Established drug makers; excludes biotech and devices'),
    ('Medical Devices', 'IHI', 'Devices and diagnostics; excludes pharma and biotech'),
    ('Healthcare Services', 'IHF', 'Hospitals and managed care; excludes products'),
    ('Banks', 'KBE', 'Large and diversified banks; excludes insurance and capital markets'),
    ('Regional Banks', 'KRE', 'Regional banks only; no large-cap banks'),
    ('Insurance', 'IAK', 'P and C plus life plus reinsurance; excludes banks'),
    ('Capital Markets', 'IAI', 'Brokers and asset managers; excludes banks and insurance'),
    ('Mortgage Finance', 'REM', 'Mortgage REITs and servicers; no commercial banks'),
    ('Aerospace and Defense', 'ITA', 'Defense primes and suppliers; excludes commercial industrials'),
    ('Drones', 'DRNZ', 'UAV makers and enablers; distinct from broad defense'),
    ('Space', 'UFO', 'Pure-play space and satellite; excludes broad defense'),
    ('Industrial Automation', 'ROBO', 'Industrial automation and robotics; excludes A and D'),
    ('Construction', 'PKB', 'Engineering and construction firms; excludes homebuilders'),
    ('Transportation', 'IYT', 'Trucking rail and freight; excludes airlines'),
    ('Waste and Environment', 'EVX', 'Waste management and environmental services'),
    ('Oil and Gas E/P', 'XOP', 'Exploration and production only; excludes services and midstream'),
    ('Oil Services', 'OIH', 'Oilfield services; excludes E/P and midstream'),
    ('Pipelines', 'AMLP', 'Midstream pipelines and MLPs; excludes E/P and services'),
    ('Refiners', 'CRAK', 'Oil refiners; excludes E/P and midstream'),
    ('Nuclear', 'URA', 'Uranium miners and nuclear; no fossil fuel overlap'),
    ('Solar', 'TAN', 'Solar manufacturers and installers only'),
    ('Wind', 'FAN', 'Wind turbine makers and operators only'),
    ('Diversified Clean Energy', 'ICLN', 'Broad renewables excluding solar and wind pure plays'),
    ('Batteries', 'LIT', 'Lithium miners and battery makers; no solar or wind'),
    ('Power Grid', 'GRID', 'Grid and electrification infrastructure; excludes generation'),
    ('Gold Miners', 'GDX', 'Gold miners; excludes silver and base metals'),
    ('Silver Miners', 'SIL', 'Silver miners only; no gold or base metals'),
    ('Copper', 'COPX', 'Copper miners; excludes precious metals and steel'),
    ('Steel', 'SLX', 'Steel producers and processors; excludes miners'),
    ('Timber', 'WOOD', 'Timber and forest products; distinct from metals'),
    ('Agribusiness', 'MOO', 'Ag producers and equipment; excludes food manufacturers'),
    ('Residential REITs', 'REZ', 'Apartment and single-family REITs; no commercial'),
    ('Commercial REITs', 'RWR', 'Office and retail REITs; excludes residential and industrial'),
    ('Industrial REITs', 'INDS', 'Warehouse and logistics REITs; no residential or office'),
    ('Electric Utilities', 'XLU', 'Regulated electric utilities; broad utility coverage'),
    ('Water', 'PHO', 'Water utilities and treatment; excludes electric'),
    ('Infrastructure', 'PAVE', 'Roads bridges and airports; excludes REITs and utilities'),
    ('Critical Minerals', 'REMX', 'Rare earth and strategic mineral producers');
