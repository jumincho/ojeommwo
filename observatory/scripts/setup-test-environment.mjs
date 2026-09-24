// Observatory tests import the parent bot contract directly. Keep that import
// hermetic and independent of the protected production .env file.
process.env.NODE_ENV = "test";
