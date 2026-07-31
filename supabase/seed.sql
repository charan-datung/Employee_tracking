-- Local development seed data. Applied by `supabase db reset` on a fresh DB.
-- Fixed UUIDs so local tooling and tests can reference rows deterministically.
-- auth_user_id is left NULL — link agents to real Supabase auth users locally
-- after signing them up.

-- -----------------------------------------------------------------------------
-- Branches (2)
-- -----------------------------------------------------------------------------

insert into public.branches (id, name, code, address, lat, lng, geofence_radius_m, is_active) values
  ('11111111-1111-4111-8111-111111111101', 'Las Piñas Zapote Branch',
   'LPZ', 'Alabang–Zapote Rd, Pamplona Uno, Las Piñas City', 14.4512, 120.9822, 150, true),
  ('11111111-1111-4111-8111-111111111102', 'Bacoor Aguinaldo Branch',
   'BCR', 'Gen. Emilio Aguinaldo Hwy, Talaba VII, Bacoor City, Cavite', 14.4457, 120.9536, 150, true);

-- -----------------------------------------------------------------------------
-- Agents (1 field supervisor + 6 field agents)
-- -----------------------------------------------------------------------------

insert into public.agents (id, employee_no, full_name, mobile_no, role, branch_id, supervisor_agent_id, employment_status, hired_at) values
  -- supervisor first: the six agents below reference him
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'DTG-0001', 'Ramon C. Villanueva', '+639171230001',
   'field_supervisor', '11111111-1111-4111-8111-111111111101', null, 'active', '2021-03-01T00:00:00+08'),

  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', 'DTG-0002', 'Maricel D. Santos', '+639171230002',
   'sales_agent', '11111111-1111-4111-8111-111111111101',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'active', '2022-06-15T00:00:00+08'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', 'DTG-0003', 'Jerome B. Aquino', '+639171230003',
   'collector', '11111111-1111-4111-8111-111111111101',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'active', '2022-09-01T00:00:00+08'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', 'DTG-0004', 'Katrina L. Mendoza', '+639171230004',
   'collector', '11111111-1111-4111-8111-111111111101',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'active', '2023-01-10T00:00:00+08'),

  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05', 'DTG-0005', 'Paolo S. Reyes', '+639171230005',
   'sales_agent', '11111111-1111-4111-8111-111111111102',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'active', '2022-11-07T00:00:00+08'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', 'DTG-0006', 'Angelica M. dela Cruz', '+639171230006',
   'collector', '11111111-1111-4111-8111-111111111102',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'active', '2023-04-03T00:00:00+08'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', 'DTG-0007', 'Nestor P. Garcia', '+639171230007',
   'collector', '11111111-1111-4111-8111-111111111102',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'active', '2023-08-21T00:00:00+08');

-- -----------------------------------------------------------------------------
-- Clients (40) — Parañaque, Las Piñas, Muntinlupa (LPZ book);
--                Bacoor, Imus (BCR book)
-- -----------------------------------------------------------------------------

insert into public.clients
  (id, external_ref, display_name, account_type, address_text, barangay, city,
   lat, lng, geofence_radius_m, geocode_confidence, assigned_agent_id, is_active)
values
  -- Parañaque (8)
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0001', 'ODOO-P-10001', 'Lourdes Bakeshop', 'trust_loan_sme',
   '32 Aguirre Ave', 'BF Homes', 'Parañaque', 14.4770, 121.0208, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0002', 'ODOO-P-10002', 'Teresita R. Manalo', 'coco_martin_group',
   '18 Sta. Rita St', 'San Antonio', 'Parañaque', 14.4781, 121.0157, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0003', 'ODOO-P-10003', 'Sucat Hardware & Electrical', 'trust_loan_sme',
   '211 Dr. A. Santos Ave', 'Sucat', 'Parañaque', 14.4645, 121.0470, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0004', 'ODOO-P-10004', 'Efren T. Dizon', 'coco_martin_group',
   '9 St. Joseph St', 'Don Bosco', 'Parañaque', 14.4790, 121.0224, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0005', 'ODOO-P-10005', 'Baclaran RTW Stall 44', 'trust_loan_sme',
   'Redemptorist Rd Market', 'Baclaran', 'Parañaque', 14.5312, 120.9938, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0006', 'ODOO-P-10006', 'Rowena F. Salazar', 'coco_martin_group',
   '77 Quirino Ave', 'San Dionisio', 'Parañaque', 14.4938, 121.0096, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0007', 'ODOO-P-10007', 'Moonwalk Sari-Sari & LPG', 'trust_loan_sme',
   'Blk 3 Lot 21 E. Rodriguez St', 'Moonwalk', 'Parañaque', 14.4862, 121.0169, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0008', 'ODOO-P-10008', 'Danilo V. Ocampo', 'coco_martin_group',
   '5 Sampaguita St', 'Marcelo Green', 'Parañaque', 14.4712, 121.0438, 120, 'unverified',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),

  -- Las Piñas (8)
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0009', 'ODOO-P-10009', 'Talon Uno Rice Trading', 'trust_loan_sme',
   '88 Real St', 'Talon Uno', 'Las Piñas', 14.4325, 120.9945, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0010', 'ODOO-P-10010', 'Cristina J. Navarro', 'coco_martin_group',
   'Blk 12 Lot 4 Gloria Diaz St', 'BF Resort', 'Las Piñas', 14.4368, 120.9878, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0011', 'ODOO-P-10011', 'Pamplona Auto Parts', 'trust_loan_sme',
   '452 Alabang–Zapote Rd', 'Pamplona Tres', 'Las Piñas', 14.4485, 120.9801, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0012', 'ODOO-P-10012', 'Marites A. Coronel', 'coco_martin_group',
   '31 M. Roxas St', 'Pulang Lupa Uno', 'Las Piñas', 14.4611, 120.9784, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0013', 'ODOO-P-10013', 'Almanza Water Refilling', 'trust_loan_sme',
   '17 Lopez Ave', 'Almanza Uno', 'Las Piñas', 14.4283, 121.0064, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0014', 'ODOO-P-10014', 'Bernardo K. Estrella', 'coco_martin_group',
   '203 Marcos Alvarez Ave', 'Talon Cinco', 'Las Piñas', 14.4231, 120.9989, 120, 'unverified',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0015', 'ODOO-P-10015', 'Zapote Fish Dealer', 'trust_loan_sme',
   'Zapote Public Market', 'Zapote', 'Las Piñas', 14.4553, 120.9768, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0016', 'ODOO-P-10016', 'Josefina Q. Ramos', 'coco_martin_group',
   'Blk 7 Lot 15 CAA Rd', 'CAA-BF International', 'Las Piñas', 14.4462, 120.9908, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),

  -- Muntinlupa (8)
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0017', 'ODOO-P-10017', 'Alabang Carinderia ni Aling Nene', 'trust_loan_sme',
   '12 Montillano St', 'Alabang', 'Muntinlupa', 14.4195, 121.0412, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0018', 'ODOO-P-10018', 'Reynaldo M. Bautista', 'coco_martin_group',
   '45 Bulihan St', 'Putatan', 'Muntinlupa', 14.3972, 121.0431, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0019', 'ODOO-P-10019', 'Poblacion Vulcanizing Shop', 'trust_loan_sme',
   'National Rd cor. Rizal St', 'Poblacion', 'Muntinlupa', 14.3834, 121.0473, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0020', 'ODOO-P-10020', 'Imelda S. Torralba', 'coco_martin_group',
   '8 Ilaya St', 'Bayanan', 'Muntinlupa', 14.3901, 121.0448, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0021', 'ODOO-P-10021', 'Tunasan Poultry Supply', 'trust_loan_sme',
   '301 National Rd', 'Tunasan', 'Muntinlupa', 14.3722, 121.0489, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0022', 'ODOO-P-10022', 'Arnel D. Panganiban', 'coco_martin_group',
   '22 Buli Rd', 'Buli', 'Muntinlupa', 14.4398, 121.0434, 120, 'unverified',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0023', 'ODOO-P-10023', 'Cupang Junkshop & Scrap', 'trust_loan_sme',
   '156 East Service Rd', 'Cupang', 'Muntinlupa', 14.4302, 121.0441, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0024', 'ODOO-P-10024', 'Gemma L. Suarez', 'coco_martin_group',
   'Blk 2 Lot 9 Katihan St', 'Sucat', 'Muntinlupa', 14.4528, 121.0482, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', true),

  -- Bacoor (8)
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0025', 'ODOO-P-10025', 'Molino Grocery & General Mdse', 'trust_loan_sme',
   'Molino Blvd', 'Molino III', 'Bacoor', 14.3892, 120.9742, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0026', 'ODOO-P-10026', 'Virgilio N. Alcantara', 'coco_martin_group',
   '73 P. Burgos St', 'Niog I', 'Bacoor', 14.4558, 120.9603, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0027', 'ODOO-P-10027', 'Zapote Eatery ni Ka Edong', 'trust_loan_sme',
   'Old Zapote Rd', 'Zapote IV', 'Bacoor', 14.4571, 120.9698, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0028', 'ODOO-P-10028', 'Corazon B. Villareal', 'coco_martin_group',
   '11 Talaba Diversion Rd', 'Talaba IV', 'Bacoor', 14.4522, 120.9572, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0029', 'ODOO-P-10029', 'Queens Row Motor Parts', 'trust_loan_sme',
   'Blk 5 Queens Row Ave', 'Queens Row East', 'Bacoor', 14.4031, 120.9797, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0030', 'ODOO-P-10030', 'Rodel C. Magbanua', 'coco_martin_group',
   '39 Panapaan Rd', 'Panapaan II', 'Bacoor', 14.4473, 120.9502, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0031', 'ODOO-P-10031', 'Mambog Rice & Feeds', 'trust_loan_sme',
   '204 Mambog Rd', 'Mambog III', 'Bacoor', 14.4268, 120.9558, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0032', 'ODOO-P-10032', 'Evangeline P. Custodio', 'coco_martin_group',
   'Blk 9 Lot 2 Habay Rd', 'Habay I', 'Bacoor', 14.4419, 120.9473, 120, 'unverified',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', true),

  -- Imus (8)
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0033', 'ODOO-P-10033', 'Anabu Bakery & Snack House', 'trust_loan_sme',
   'Anabu Rd II', 'Anabu II-A', 'Imus', 14.4179, 120.9334, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0034', 'ODOO-P-10034', 'Federico G. Lazaro', 'coco_martin_group',
   '27 Bucandala Rd', 'Bucandala I', 'Imus', 14.4228, 120.9451, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0035', 'ODOO-P-10035', 'Tanzang Luma Ukay-Ukay', 'trust_loan_sme',
   '95 Tanzang Luma Rd', 'Tanzang Luma II', 'Imus', 14.4113, 120.9392, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0036', 'ODOO-P-10036', 'Luzviminda E. Roque', 'coco_martin_group',
   'Blk 14 Lot 6 Malagasang Rd', 'Malagasang I-A', 'Imus', 14.4023, 120.9427, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0037', 'ODOO-P-10037', 'Imus Poblacion Pharmacy', 'trust_loan_sme',
   'Gen. Castañeda St', 'Poblacion I-A', 'Imus', 14.4291, 120.9366, 120, 'exact',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0038', 'ODOO-P-10038', 'Wilfredo H. Trinidad', 'coco_martin_group',
   '63 Bayan Luma Rd', 'Bayan Luma II', 'Imus', 14.4204, 120.9412, 120, 'unverified',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0039', 'ODOO-P-10039', 'Toclong Auto Repair', 'trust_loan_sme',
   '4 Toclong Rd', 'Toclong I-A', 'Imus', 14.4347, 120.9443, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccc0040', 'ODOO-P-10040', 'Milagros O. Zamora', 'coco_martin_group',
   'Blk 3 Lot 18 Alapan Rd', 'Alapan I-A', 'Imus', 14.4102, 120.9263, 120, 'approximate',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07', true);
