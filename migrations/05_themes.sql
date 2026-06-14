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
    ('Semiconductors', 'SOXX', 'Chip designers & equipment; excludes software'),
    ('Software', 'IGV', 'Application & SaaS software; excludes infra & security'),
    ('Cloud Infrastructure', 'WCLD', 'Cloud-native infrastructure & platforms'),
    ('Cybersecurity', 'CIBR', 'Dedicated security vendors only'),
    ('Computing Hardware', 'XLK', 'Hardware OEMs & distributors; excludes semis & software'),
    ('Internet Platforms', 'OGIG', 'Pure internet platforms & e-commerce'),
    ('Fintech', 'IPAY', 'Payments processors & digital finance only'),
    ('Blockchain', 'BKCH', 'Crypto miners & exchanges; no payments overlap'),
    ('AI Infrastructure', 'AIQ', 'AI compute & enablers; distinct from pure software'),
    ('Data Centers', 'SRVR', 'Data center REITs and digital infrastructure'),
    ('Quantum Computing', 'QTUM', 'Quantum computing hardware, software, and enabling technologies'),
    ('IoT', 'SNSR', 'Connected devices & sensors; excludes pure software'),
    ('Telecom', 'IYZ', 'Carriers & tower companies; excludes media'),
    ('Social Media', 'SOCL', 'Social platforms; excludes carriers & traditional media'),
    ('EVs', 'DRIV', 'EV OEMs & autonomous; excludes parts & dealers'),
    ('Auto Parts', 'CARZ', 'Parts makers & dealers; no OEMs'),
    ('Homebuilders', 'ITB', 'Residential builders & building products'),
    ('Retail', 'XRT', 'Broadline & specialty retail; excludes grocery & e-commerce'),
    ('Travel', 'AWAY', 'Airlines & lodging; excludes casinos'),
    ('Casinos', 'BJK', 'Land-based & online gambling; no video games'),
    ('Gaming', 'HERO', 'Game publishers & esports; no casinos'),
    ('Food & Beverage', 'PBJ', 'Packaged food & beverages; excludes retail & restaurant'),
    ('Grocery', 'FXG', 'Grocery chains & staple retailers only'),
    ('Biotech', 'ARKG', 'Gene editing & biotech R&D; no devices or pharma'),
    ('Pharma', 'IHE', 'Established drug makers; excludes biotech & devices'),
    ('Medical Devices', 'IHI', 'Devices & diagnostics; excludes pharma & biotech'),
    ('Healthcare Services', 'IHF', 'Hospitals & managed care; excludes products'),
    ('Banks', 'KBE', 'Large & diversified banks; excludes insurance & capital markets'),
    ('Regional Banks', 'KRE', 'Regional banks only; no large-cap banks'),
    ('Insurance', 'IAK', 'P&C + life + reinsurance; excludes banks'),
    ('Capital Markets', 'IAI', 'Brokers & asset managers; excludes banks & insurance'),
    ('Mortgage Finance', 'REM', 'Mortgage REITs & servicers; no commercial banks'),
    ('Aerospace & Defense', 'ITA', 'Defense primes & subs; excludes commercial industrials'),
    ('Industrial Automation', 'ROBO', 'Industrial machinery & automation; excludes A&D'),
    ('Construction', 'PKB', 'Engineering & construction firms; excludes homebuilders'),
    ('Transportation', 'IYT', 'Trucking rail & freight; excludes airlines'),
    ('Waste & Environment', 'EVX', 'Waste management & environmental services'),
    ('Drones', 'IUAV', 'UAV makers & enablers; distinct from broad A&D'),
    ('Space', 'UFO', 'Pure-play space & satellite; excludes broad A&D'),
    ('Oil & Gas E&P', 'XOP', 'Exploration & production only; excludes services & midstream'),
    ('Oil Services', 'OIH', 'Oilfield services; excludes E&P & midstream'),
    ('Pipelines', 'AMLP', 'Midstream pipelines & MLPs; excludes E&P & services'),
    ('Refiners', 'CRAK', 'Oil refiners; excludes E&P & midstream'),
    ('Nuclear', 'URA', 'Uranium miners & nuclear; no fossil fuel overlap'),
    ('Solar', 'TAN', 'Solar manufacturers & installers only'),
    ('Wind', 'FAN', 'Wind turbine makers & operators only'),
    ('Diversified Clean Energy', 'ICLN', 'Broad renewables ex-solar & wind pure plays'),
    ('Batteries', 'LIT', 'Lithium miners & battery makers; no solar or wind'),
    ('Power Grid', 'GRID', 'Grid & electrification infrastructure; excludes generation'),
    ('Gold Miners', 'GDX', 'Gold miners; excludes silver & base metals'),
    ('Silver Miners', 'SIL', 'Silver miners only; no gold or base metals'),
    ('Copper', 'COPX', 'Copper miners; excludes precious metals & steel'),
    ('Steel', 'SLX', 'Steel producers & processors; excludes miners'),
    ('Timber', 'WOOD', 'Timber & forest products; distinct from metals'),
    ('Agribusiness', 'MOO', 'Ag producers & equipment; excludes food manufacturers'),
    ('Residential REITs', 'REZ', 'Apartment & single-family REITs; no commercial'),
    ('Commercial REITs', 'RWR', 'Office & retail REITs; excludes residential & industrial'),
    ('Industrial REITs', 'INDS', 'Warehouse & logistics REITs; no residential or office'),
    ('Electric Utilities', 'XLU', 'Regulated electric utilities; broadest utility coverage'),
    ('Water', 'PHO', 'Water utilities & treatment; excludes electric'),
    ('Infrastructure', 'PAVE', 'Roads bridges & airports; excludes REITs & utilities'),
    ('Robotics Technology', 'ROBT', 'Robotics & AI hardware; excludes pure software'),
    ('Senior Care', 'AGNG', 'Senior care services & products; distinct niche'),
    ('Critical Minerals', 'REMX', 'Rare earth and strategic mineral producers');
